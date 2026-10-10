import { describe, expect, it } from "bun:test";
import { formatProbeLatestResults, resolveTier } from "./probe-queries";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW_MS = 1_700_000_000_000;

describe("resolveTier", () => {
  describe("auto", () => {
    it("returns raw for short spans anchored near now", () => {
      const fromMs = NOW_MS - HOUR_MS;
      expect(resolveTier("auto", fromMs, NOW_MS, NOW_MS)).toBe("raw");
    });

    it("returns raw for an exactly-24h span anchored at now", () => {
      const fromMs = NOW_MS - DAY_MS;
      expect(resolveTier("auto", fromMs, NOW_MS, NOW_MS)).toBe("raw");
    });

    it("returns hourly for spans wider than 24h", () => {
      const fromMs = NOW_MS - DAY_MS - HOUR_MS;
      expect(resolveTier("auto", fromMs, NOW_MS, NOW_MS)).toBe("hourly");
    });

    it("avoids raw when fromMs is outside the raw retention window", () => {
      const fromMs = NOW_MS - 5 * DAY_MS;
      const toMs = fromMs + DAY_MS;
      expect(resolveTier("auto", fromMs, toMs, NOW_MS)).toBe("hourly");
    });

    it("returns hourly for week-long spans within hourly retention", () => {
      const fromMs = NOW_MS - 7 * DAY_MS;
      expect(resolveTier("auto", fromMs, NOW_MS, NOW_MS)).toBe("hourly");
    });

    it("falls back to daily once fromMs is beyond hourly retention", () => {
      const fromMs = NOW_MS - 120 * DAY_MS;
      const toMs = fromMs + DAY_MS;
      expect(resolveTier("auto", fromMs, toMs, NOW_MS)).toBe("daily");
    });
  });

  describe("explicit tier (downgrades when data is unavailable)", () => {
    it("honors raw when fromMs is fresh", () => {
      const fromMs = NOW_MS - HOUR_MS;
      expect(resolveTier("raw", fromMs, NOW_MS, NOW_MS)).toBe("raw");
    });

    it("downgrades raw to hourly when fromMs is past raw retention", () => {
      const fromMs = NOW_MS - 5 * DAY_MS;
      const toMs = fromMs + HOUR_MS;
      expect(resolveTier("raw", fromMs, toMs, NOW_MS)).toBe("hourly");
    });

    it("downgrades raw to daily when fromMs is past hourly retention", () => {
      const fromMs = NOW_MS - 200 * DAY_MS;
      const toMs = fromMs + HOUR_MS;
      expect(resolveTier("raw", fromMs, toMs, NOW_MS)).toBe("daily");
    });

    it("downgrades hourly to daily when fromMs is past hourly retention", () => {
      const fromMs = NOW_MS - 200 * DAY_MS;
      const toMs = fromMs + DAY_MS;
      expect(resolveTier("hourly", fromMs, toMs, NOW_MS)).toBe("daily");
    });

    it("always returns daily when requested", () => {
      const fromMs = NOW_MS - HOUR_MS;
      expect(resolveTier("daily", fromMs, NOW_MS, NOW_MS)).toBe("daily");
    });
  });

  describe("raw retention safety margin", () => {
    it("treats `now - 2d + 1h` as the inclusive raw boundary", () => {
      const rawFloorMs = NOW_MS - 2 * DAY_MS + HOUR_MS;
      expect(resolveTier("raw", rawFloorMs, NOW_MS, NOW_MS)).toBe("raw");
      expect(resolveTier("raw", rawFloorMs - 1, NOW_MS, NOW_MS)).toBe("hourly");
    });
  });
});

describe("public TCP probe diagnostics", () => {
  const row: Parameters<typeof formatProbeLatestResults>[0][number] = {
    taskId: "task",
    tsMs: NOW_MS,
    recvTsMs: NOW_MS,
    ok: false,
    latMs: null,
    code: null,
    err: "packet_too_large",
    extraJson: JSON.stringify({
      packet_size_bytes: 1200,
      host: "private.example",
      addrs: ["10.0.0.1"],
      last_error: { message: "private diagnostic" },
      probe_style: "tcp_syn",
    }),
    lossPct: null,
    jitterMs: null,
    updatedAtMs: NOW_MS,
    taskName: "TCP",
    taskKind: "tcp",
    taskEnabled: true,
    taskTraceRevealHopDetails: false,
    taskIntervalSec: 60,
    taskUpdatedAtMs: NOW_MS,
  };

  it.each(["full", "anonymized"] as const)(
    "only exposes the code and packet-size snapshot for %s",
    (privacy) => {
      const result = formatProbeLatestResults([row], privacy)[0]!;
      expect(result.latest.err).toBe("packet_too_large");
      expect(result.latest.extra).toEqual({ packet_size_bytes: 1200 });
      expect(result.latest.extraRawJson).toBeNull();
      expect(JSON.stringify(result)).not.toContain("private");
      expect(JSON.stringify(result)).not.toContain("10.0.0.1");
    },
  );

  it.each([
    "timeout",
    "connection_refused",
    "permission_denied",
    "connect_failed",
    "packet_too_large",
    "dest_unreachable",
    "ipv6_not_supported",
    "unsupported_platform",
    "dns_lookup_failed",
    "dns_no_records",
  ])("exposes known error %s", (err) => {
    expect(formatProbeLatestResults([{ ...row, err }], "anonymized")[0]?.latest.err).toBe(err);
  });

  it.each([null, "socket error for private.example", "__proto__", "constructor"])(
    "does not publish arbitrary errors %s",
    (err) => {
      expect(formatProbeLatestResults([{ ...row, err }], "anonymized")[0]?.latest.err).toBeNull();
    },
  );

  it.each([
    null,
    "{private",
    "[]",
    '{"packet_size_bytes":"1200"}',
    '{"packet_size_bytes":44}',
    '{"host":"private.example"}',
  ])("does not leak malformed or unrelated metadata %s", (extraJson) => {
    const latest = formatProbeLatestResults([{ ...row, extraJson }], "anonymized")[0]!.latest;
    expect(latest.extra).toBeNull();
    expect(latest.extraRawJson).toBeNull();
    expect(latest.extraParseError).toBe(false);
    expect(latest.err).toBe("packet_too_large");
  });

  it("keeps success metadata but never displays a stale error on success", () => {
    const latest = formatProbeLatestResults(
      [{ ...row, ok: true, latMs: 12, extraJson: '{"packet_size_bytes":40}' }],
      "anonymized",
    )[0]!.latest;
    expect(latest.err).toBeNull();
    expect(latest.extra).toEqual({ packet_size_bytes: 40 });
  });

  it.each(["icmp", "http"])("does not change %s diagnostic exposure", (taskKind) => {
    const latest = formatProbeLatestResults([{ ...row, taskKind }], "anonymized")[0]!.latest;
    expect(latest.err).toBeNull();
    expect(latest.extra).toBeNull();
  });
});
