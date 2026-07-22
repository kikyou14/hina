import { describe, expect, test } from "bun:test";

import { isPublicTelemetryDeltaV2, type PublicTelemetryDeltaV1 } from "../src/live/publicMessages";

function v1Delta(): PublicTelemetryDeltaV1 {
  return {
    type: "event.public.telemetry_delta",
    agentId: "agent-1",
    tsMs: 1000,
    metrics: { "cpu.usage_pct": 42 },
    deltaRx: 10,
    deltaTx: 20,
  };
}

// A protocol v1 server sends this shape as an untyped object; cast it to the v1
// wire type so the guard sees exactly what a legacy server would produce.
function v2Delta(overrides: Partial<Record<string, unknown>> = {}): PublicTelemetryDeltaV1 {
  return {
    ...v1Delta(),
    seq: 7,
    uptimeSec: 3600,
    rx: 500,
    tx: 600,
    billing: {
      quotaBytes: 1_000,
      mode: "sum",
      resetDay: 1,
      periodStartDayYyyyMmDd: 20260701,
      periodEndDayYyyyMmDd: 20260722,
      rxBytes: 200,
      txBytes: 300,
      usedBytes: 500,
      overQuota: false,
    },
    traffic: {
      totalRxBytes: 1_000,
      totalTxBytes: 2_000,
      sinceDayYyyyMmDd: 20260701,
    },
    ...overrides,
  } as PublicTelemetryDeltaV1;
}

describe("isPublicTelemetryDeltaV2", () => {
  test("accepts a complete v2 delta", () => {
    expect(isPublicTelemetryDeltaV2(v2Delta())).toBe(true);
  });

  test("rejects a legacy v1 delta missing the v2 fields", () => {
    expect(isPublicTelemetryDeltaV2(v1Delta())).toBe(false);
  });

  test("accepts null billing/traffic (present but empty on v2)", () => {
    expect(isPublicTelemetryDeltaV2(v2Delta({ billing: null, traffic: null }))).toBe(true);
  });

  test("accepts null uptimeSec", () => {
    expect(isPublicTelemetryDeltaV2(v2Delta({ uptimeSec: null }))).toBe(true);
  });

  test("rejects a partially-populated delta (missing rx)", () => {
    expect(isPublicTelemetryDeltaV2(v2Delta({ rx: undefined }))).toBe(false);
  });

  test("rejects when billing is absent even if counters are present", () => {
    expect(isPublicTelemetryDeltaV2(v2Delta({ billing: undefined }))).toBe(false);
  });

  test("rejects when traffic is absent", () => {
    expect(isPublicTelemetryDeltaV2(v2Delta({ traffic: undefined }))).toBe(false);
  });

  test("rejects a non-numeric seq", () => {
    expect(isPublicTelemetryDeltaV2(v2Delta({ seq: "7" }))).toBe(false);
  });
});
