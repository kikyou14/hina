import { describe, expect, test } from "bun:test";

import { buildTraceCompareRows } from "../src/components/probes/TracerouteTraceDetail";
import { parseTracerouteView } from "../src/lib/traceroute";
import type { TracerouteHop } from "../src/lib/traceroute";

function hop(ttl: number, ip: string | null, rttMs = 1): TracerouteHop {
  return {
    ttl,
    responses: ip === null ? [] : [{ ip, hostname: null, asn_info: null, rtt_ms: rttMs }],
    timeouts: ip === null ? 1 : 0,
  };
}

describe("buildTraceCompareRows", () => {
  test("marks no row as diverged when both sides match at every ttl", () => {
    const left = [hop(1, "10.0.0.1"), hop(2, "10.0.0.2"), hop(3, "10.0.0.3")];
    const right = [hop(1, "10.0.0.1"), hop(2, "10.0.0.2"), hop(3, "10.0.0.3")];
    const rows = buildTraceCompareRows(left, right);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !r.diverged)).toBe(true);
  });

  test("flags a row as diverged only where both sides return concrete, differing IPs", () => {
    const left = [hop(1, "10.0.0.1"), hop(2, "192.0.2.5")];
    const right = [hop(1, "10.0.0.1"), hop(2, "192.0.2.9")];
    const rows = buildTraceCompareRows(left, right);
    expect(rows[0]?.diverged).toBe(false);
    expect(rows[1]?.diverged).toBe(true);
  });

  test("does not mark a timeout on one side as a divergence", () => {
    const left = [hop(1, "10.0.0.1"), hop(2, null)];
    const right = [hop(1, "10.0.0.1"), hop(2, "192.0.2.9")];
    const rows = buildTraceCompareRows(left, right);
    expect(rows[1]?.left.status).toBe("timeout");
    expect(rows[1]?.diverged).toBe(false);
  });

  test("does not mark a timeout on both sides as a divergence", () => {
    const left = [hop(1, null)];
    const right = [hop(1, null)];
    const rows = buildTraceCompareRows(left, right);
    expect(rows[0]?.left.status).toBe("timeout");
    expect(rows[0]?.right.status).toBe("timeout");
    expect(rows[0]?.diverged).toBe(false);
  });

  test("treats a ttl beyond one side's recorded range as blank, not diverged", () => {
    // Left reached its destination at ttl 2 and stopped probing further;
    // right continues to ttl 4.
    const left = [hop(1, "10.0.0.1"), hop(2, "203.0.113.10")];
    const right = [
      hop(1, "10.0.0.1"),
      hop(2, "192.0.2.9"),
      hop(3, "192.0.2.10"),
      hop(4, "203.0.113.10"),
    ];
    const rows = buildTraceCompareRows(left, right);
    expect(rows).toHaveLength(4);
    expect(rows[2]?.left.status).toBe("blank");
    expect(rows[3]?.left.status).toBe("blank");
    expect(rows.every((r) => !r.diverged)).toBe(false); // ttl 2 still diverges
    expect(rows[2]?.diverged).toBe(false);
    expect(rows[3]?.diverged).toBe(false);
  });

  test("identifies the first diverging ttl in a realistic mixed scenario", () => {
    // Matches ttl 1-5, diverges at ttl 6, then a timeout and a blank tail —
    // none of which should be mistaken for further divergence.
    const small: TracerouteHop[] = [
      hop(1, "10.0.0.1"),
      hop(2, "10.0.0.2"),
      hop(3, "10.0.0.3"),
      hop(4, "10.0.0.4"),
      hop(5, "10.0.0.5"),
      hop(6, "198.51.100.5"),
      hop(7, null),
      hop(8, "203.0.113.10"),
    ];
    const large: TracerouteHop[] = [
      hop(1, "10.0.0.1"),
      hop(2, "10.0.0.2"),
      hop(3, "10.0.0.3"),
      hop(4, "10.0.0.4"),
      hop(5, "10.0.0.5"),
      hop(6, "198.51.100.9"),
      hop(7, "198.51.100.20"),
      hop(8, null),
      hop(9, null),
      hop(10, "203.0.113.10"),
    ];

    const rows = buildTraceCompareRows(small, large);
    expect(rows).toHaveLength(10);

    const divergedTtls = rows.filter((r) => r.diverged).map((r) => r.ttl);
    expect(divergedTtls).toEqual([6]);

    const firstDiverged = rows.find((r) => r.diverged)?.ttl ?? null;
    expect(firstDiverged).toBe(6);
  });

  test("matches the first_diverging_ttl reported by a parsed v2 result", () => {
    const view = parseTracerouteView({
      kind: "traceroute",
      v: 2,
      target: "example.com",
      target_ip: "203.0.113.10",
      origin_ip: "192.0.2.10",
      destination_asn_info: null,
      protocol_used: "tcp",
      socket_mode_used: "raw",
      probe_style: "tcp_syn_payload",
      port: 443,
      start_ttl: 1,
      max_hops: 30,
      queries_per_hop: 1,
      total_duration_ms: 12345,
      traces: [
        {
          packet_size_bytes: 64,
          destination_reached: true,
          avg_rtt_ms: 5,
          error_code: null,
          path_mtu_bytes: null,
          hops: [hop(1, "10.0.0.1"), hop(2, "192.0.2.5")],
        },
        {
          packet_size_bytes: 1400,
          destination_reached: true,
          avg_rtt_ms: 6,
          error_code: null,
          path_mtu_bytes: null,
          hops: [hop(1, "10.0.0.1"), hop(2, "192.0.2.9")],
        },
      ],
      comparison: { comparable: true, route_diverged: true, first_diverging_ttl: 2 },
    });

    expect(view).not.toBeNull();
    const [small, large] = view!.traces;
    const rows = buildTraceCompareRows(small!.hops, large!.hops);
    const firstDiverged = rows.find((r) => r.diverged)?.ttl ?? null;
    expect(firstDiverged).toBe(view!.comparison?.firstDivergingTtl);
  });

  test("does not mark the frag-needed reporter hop as diverged", () => {
    // The large side's TTL-4 entry is the Fragmentation Needed reporter — the
    // TTL-3 router answering at forwarding time — so differing from the small
    // side's genuine TTL-4 hop is not routing evidence.
    const small = [hop(3, "192.0.2.3"), hop(4, "192.0.2.4")];
    const large = [hop(3, "192.0.2.3"), hop(4, "192.0.2.3")];
    const rows = buildTraceCompareRows(small, large, { rightFragHopTtl: 4 });

    const fragRow = rows.find((r) => r.ttl === 4);
    expect(fragRow?.mtuLimited).toBe(true);
    expect(fragRow?.diverged).toBe(false);
    expect(rows.every((r) => !r.diverged)).toBe(true);
  });

  test("still flags a genuine divergence before the frag-needed hop", () => {
    const small = [hop(1, "10.0.0.1"), hop(2, "192.0.2.5"), hop(3, "192.0.2.6")];
    const large = [hop(1, "10.0.0.1"), hop(2, "192.0.2.9"), hop(3, "192.0.2.5")];
    const rows = buildTraceCompareRows(small, large, { rightFragHopTtl: 3 });

    expect(rows.filter((r) => r.diverged).map((r) => r.ttl)).toEqual([2]);
    expect(rows[2]?.mtuLimited).toBe(true);
  });

  test("consumes fragHopTtl from a parsed v2 result", () => {
    const view = parseTracerouteView({
      kind: "traceroute",
      v: 2,
      target: "example.com",
      target_ip: "203.0.113.10",
      origin_ip: "192.0.2.10",
      destination_asn_info: null,
      protocol_used: "tcp",
      socket_mode_used: "raw",
      probe_style: "tcp_syn_payload",
      port: 443,
      start_ttl: 1,
      max_hops: 30,
      queries_per_hop: 1,
      total_duration_ms: 12345,
      traces: [
        {
          packet_size_bytes: 64,
          destination_reached: true,
          avg_rtt_ms: 5,
          error_code: null,
          path_mtu_bytes: null,
          hops: [hop(1, "10.0.0.1"), hop(2, "192.0.2.5")],
        },
        {
          packet_size_bytes: 1400,
          destination_reached: false,
          avg_rtt_ms: 6,
          error_code: "packet_too_large",
          path_mtu_bytes: 1400,
          frag_hop_ttl: 2,
          hops: [hop(1, "10.0.0.1"), hop(2, "10.0.0.1")],
        },
      ],
      comparison: { comparable: true, route_diverged: false, first_diverging_ttl: null },
    });

    expect(view).not.toBeNull();
    const [small, large] = view!.traces;
    expect(large!.fragHopTtl).toBe(2);

    const rows = buildTraceCompareRows(small!.hops, large!.hops, {
      leftFragHopTtl: small!.fragHopTtl,
      rightFragHopTtl: large!.fragHopTtl,
    });
    expect(rows.every((r) => !r.diverged)).toBe(true);
    expect(rows[1]?.mtuLimited).toBe(true);
  });
});
