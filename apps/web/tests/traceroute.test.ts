import { describe, expect, test } from "bun:test";

import {
  parseTracerouteExtraV1,
  parseTracerouteExtraV2,
  parseTracerouteView,
  toTracerouteView,
  type TracerouteExtraV1,
  type TracerouteExtraV2,
} from "../src/lib/traceroute";

function validV1(overrides: Partial<TracerouteExtraV1> = {}): unknown {
  return {
    kind: "traceroute",
    v: 1,
    target: "example.com",
    target_ip: "203.0.113.10",
    origin_ip: "192.0.2.10",
    destination_asn_info: null,
    destination_reached: true,
    total_duration_ms: 5000,
    avg_rtt_ms: 12.5,
    protocol_used: "icmp",
    socket_mode_used: "raw",
    start_ttl: 1,
    max_hops: 30,
    queries_per_hop: 1,
    hops: [
      {
        ttl: 1,
        responses: [{ ip: "192.0.2.1", hostname: null, asn_info: null, rtt_ms: 0.8 }],
        timeouts: 0,
      },
      { ttl: 2, responses: [], timeouts: 1 },
    ],
    ...overrides,
  };
}

function validV2(overrides: Partial<TracerouteExtraV2> = {}): unknown {
  return {
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
        avg_rtt_ms: 18.2,
        error_code: null,
        path_mtu_bytes: null,
        hops: [
          {
            ttl: 1,
            responses: [{ ip: "192.0.2.1", hostname: null, asn_info: null, rtt_ms: 0.8 }],
            timeouts: 0,
          },
        ],
      },
      {
        packet_size_bytes: 1400,
        destination_reached: true,
        avg_rtt_ms: 31.4,
        error_code: null,
        path_mtu_bytes: null,
        hops: [],
      },
    ],
    comparison: { comparable: true, route_diverged: true, first_diverging_ttl: 6 },
    ...overrides,
  };
}

describe("parseTracerouteExtraV1", () => {
  test("accepts a well-formed v1 payload", () => {
    const result = parseTracerouteExtraV1(validV1());
    expect(result).not.toBeNull();
    expect(result?.v).toBe(1);
    expect(result?.hops).toHaveLength(2);
    expect(result?.hops[0]?.responses[0]?.ip).toBe("192.0.2.1");
  });

  test("accepts a valid destination_asn_info object", () => {
    const result = parseTracerouteExtraV1(
      validV1({
        destination_asn_info: {
          asn: 64500,
          prefix: "203.0.113.0/24",
          country_code: "US",
          registry: "arin",
          name: "Example Net",
        },
      }),
    );
    expect(result?.destination_asn_info?.asn).toBe(64500);
  });

  test("rejects non-object input", () => {
    expect(parseTracerouteExtraV1(null)).toBeNull();
    expect(parseTracerouteExtraV1("traceroute")).toBeNull();
    expect(parseTracerouteExtraV1([1, 2, 3])).toBeNull();
    expect(parseTracerouteExtraV1(undefined)).toBeNull();
  });

  test("rejects the wrong kind or version", () => {
    expect(parseTracerouteExtraV1(validV1({ kind: "ping" as never }))).toBeNull();
    expect(parseTracerouteExtraV1(validV1({ v: 2 as never }))).toBeNull();
  });

  test("rejects a malformed destination_asn_info", () => {
    expect(
      parseTracerouteExtraV1(validV1({ destination_asn_info: { asn: 1 } as never })),
    ).toBeNull();
  });

  test("rejects hops with non-increasing ttl", () => {
    const payload = validV1({
      hops: [
        { ttl: 2, responses: [], timeouts: 0 },
        { ttl: 1, responses: [], timeouts: 0 },
      ] as never,
    });
    expect(parseTracerouteExtraV1(payload)).toBeNull();
  });

  test("rejects hops with a zero or negative ttl", () => {
    const payload = validV1({ hops: [{ ttl: 0, responses: [], timeouts: 0 }] as never });
    expect(parseTracerouteExtraV1(payload)).toBeNull();
  });

  test("rejects a response with malformed asn_info", () => {
    const payload = validV1({
      hops: [
        {
          ttl: 1,
          responses: [
            { ip: "1.1.1.1", hostname: null, asn_info: { asn: "not-a-number" }, rtt_ms: 1 },
          ],
          timeouts: 0,
        },
      ] as never,
    });
    expect(parseTracerouteExtraV1(payload)).toBeNull();
  });

  test("accepts an empty hops array", () => {
    const result = parseTracerouteExtraV1(validV1({ hops: [] }));
    expect(result?.hops).toEqual([]);
  });
});

describe("parseTracerouteExtraV2", () => {
  test("accepts a well-formed v2 payload", () => {
    const result = parseTracerouteExtraV2(validV2());
    expect(result).not.toBeNull();
    expect(result?.v).toBe(2);
    expect(result?.traces).toHaveLength(2);
    expect(result?.traces[0]?.packet_size_bytes).toBe(64);
    expect(result?.traces[1]?.packet_size_bytes).toBe(1400);
    expect(result?.comparison).toEqual({
      comparable: true,
      route_diverged: true,
      first_diverging_ttl: 6,
    });
  });

  test("rejects a v1 payload (wrong version)", () => {
    expect(parseTracerouteExtraV2(validV1())).toBeNull();
  });

  test("rejects a payload missing comparison", () => {
    const payload = validV2() as Record<string, unknown>;
    delete payload["comparison"];
    expect(parseTracerouteExtraV2(payload)).toBeNull();
  });

  test("rejects a trace missing packet_size_bytes entirely", () => {
    const payload = validV2();
    const trace = (payload as Record<string, unknown>)["traces"] as Array<Record<string, unknown>>;
    delete trace[0]!["packet_size_bytes"];
    expect(parseTracerouteExtraV2(payload)).toBeNull();
  });

  test("rejects a non-string, non-null error_code", () => {
    expect(
      parseTracerouteExtraV2(
        validV2({
          traces: [
            {
              packet_size_bytes: 64,
              destination_reached: false,
              avg_rtt_ms: null,
              error_code: 404 as never,
              path_mtu_bytes: null,
              frag_hop_ttl: null,
              hops: [],
            },
            {
              packet_size_bytes: 1400,
              destination_reached: false,
              avg_rtt_ms: null,
              error_code: null,
              path_mtu_bytes: null,
              frag_hop_ttl: null,
              hops: [],
            },
          ],
        }),
      ),
    ).toBeNull();
  });

  test("rejects a non-numeric, non-null first_diverging_ttl", () => {
    expect(
      parseTracerouteExtraV2(
        validV2({
          comparison: {
            comparable: true,
            route_diverged: true,
            first_diverging_ttl: true as never,
          },
        }),
      ),
    ).toBeNull();
  });

  test("accepts error_code and path_mtu_bytes for a packet_too_large trace", () => {
    const result = parseTracerouteExtraV2(
      validV2({
        traces: [
          {
            packet_size_bytes: 64,
            destination_reached: true,
            avg_rtt_ms: 18.2,
            error_code: null,
            path_mtu_bytes: null,
            frag_hop_ttl: null,
            hops: [],
          },
          {
            packet_size_bytes: 1400,
            destination_reached: false,
            avg_rtt_ms: null,
            error_code: "packet_too_large",
            path_mtu_bytes: 1280,
            frag_hop_ttl: 4,
            hops: [],
          },
        ],
      }),
    );
    expect(result?.traces[1]?.error_code).toBe("packet_too_large");
    expect(result?.traces[1]?.path_mtu_bytes).toBe(1280);
    expect(result?.traces[1]?.frag_hop_ttl).toBe(4);
  });

  test("normalizes an absent frag_hop_ttl (pre-field results) to null", () => {
    const result = parseTracerouteExtraV2(validV2());
    expect(result?.traces[0]?.frag_hop_ttl).toBeNull();
    expect(result?.traces[1]?.frag_hop_ttl).toBeNull();
  });

  test("rejects a non-numeric, non-null frag_hop_ttl", () => {
    const payload = validV2();
    const trace = (payload as Record<string, unknown>)["traces"] as Array<Record<string, unknown>>;
    trace[1]!["frag_hop_ttl"] = "4";
    expect(parseTracerouteExtraV2(payload)).toBeNull();
  });

  test("rejects a trace's hops with non-increasing ttl", () => {
    const payload = validV2();
    const trace = (payload as Record<string, unknown>)["traces"] as Array<Record<string, unknown>>;
    trace[0]!["hops"] = [
      { ttl: 3, responses: [], timeouts: 0 },
      { ttl: 2, responses: [], timeouts: 0 },
    ];
    expect(parseTracerouteExtraV2(payload)).toBeNull();
  });
});

describe("toTracerouteView", () => {
  test("normalizes v1 into a single trace with no comparison", () => {
    const v1 = parseTracerouteExtraV1(validV1())!;
    const view = toTracerouteView(v1);
    expect(view.traces).toHaveLength(1);
    expect(view.traces[0]?.packetSizeBytes).toBeNull();
    expect(view.traces[0]?.destinationReached).toBe(true);
    expect(view.traces[0]?.hops).toBe(v1.hops);
    expect(view.comparison).toBeNull();
    expect(view.port).toBeNull();
    expect(view.probeStyle).toBeNull();
  });

  test("maps an unrecognized v1 protocol_used to icmp", () => {
    const v1 = parseTracerouteExtraV1(validV1({ protocol_used: "unknown-protocol" }))!;
    expect(toTracerouteView(v1).protocol).toBe("icmp");
  });

  test("maps v1 protocol_used tcp through unchanged", () => {
    const v1 = parseTracerouteExtraV1(validV1({ protocol_used: "tcp" }))!;
    expect(toTracerouteView(v1).protocol).toBe("tcp");
  });

  test("normalizes v2 into two traces and passes comparison through", () => {
    const v2 = parseTracerouteExtraV2(validV2())!;
    const view = toTracerouteView(v2);
    expect(view.traces).toHaveLength(2);
    expect(view.traces.map((t) => t.packetSizeBytes)).toEqual([64, 1400]);
    expect(view.traces.map((t) => t.fragHopTtl)).toEqual([null, null]);
    expect(view.comparison).toEqual({
      comparable: true,
      routeDiverged: true,
      firstDivergingTtl: 6,
    });
    expect(view.protocol).toBe("tcp");
    expect(view.port).toBe(443);
    expect(view.probeStyle).toBe("tcp_syn_payload");
  });
});

describe("parseTracerouteView", () => {
  test("parses a v2 payload as a dual-trace view", () => {
    const view = parseTracerouteView(validV2());
    expect(view?.traces).toHaveLength(2);
  });

  test("parses a v1 payload as a single-trace view", () => {
    const view = parseTracerouteView(validV1());
    expect(view?.traces).toHaveLength(1);
  });

  test("returns null for a payload that matches neither version", () => {
    expect(parseTracerouteView(validV1({ v: 3 as never }))).toBeNull();
    expect(parseTracerouteView({ kind: "ping" })).toBeNull();
    expect(parseTracerouteView(null)).toBeNull();
  });
});
