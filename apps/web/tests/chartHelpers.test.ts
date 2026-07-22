import { describe, expect, test } from "bun:test";

import {
  computeCounterRate,
  computeDeltaRate,
  deriveTrafficRates,
} from "../src/pages/public/lib/chartHelpers";

describe("computeCounterRate", () => {
  test("returns null components on the first sample", () => {
    expect(computeCounterRate(null, { tsMs: 1_000, rx: 100, tx: 200 })).toEqual({
      rxRate: null,
      txRate: null,
    });
  });

  test("rate is the per-second difference of cumulative counters", () => {
    const prev = { tsMs: 0, rx: 1_000, tx: 2_000 };
    const next = { tsMs: 10_000, rx: 1_100, tx: 2_200 };
    expect(computeCounterRate(prev, next)).toEqual({ rxRate: 10, txRate: 20 });
  });

  test("stays correct when coalescing drops an intermediate frame", () => {
    // Two consecutive 10s intervals of +100 rx each. If the middle frame is
    // coalesced away by the outbox under backpressure, only the final frame
    // arrives — but its cumulative counter still reflects both intervals, so one
    // difference over the full 20s gap yields the true 200/20 = 10 B/s. Summing
    // per-frame deltas would have seen only the surviving +100 over 20s = 5 B/s.
    const first = { tsMs: 0, rx: 1_000, tx: 0 };
    const coalescedLast = { tsMs: 20_000, rx: 1_200, tx: 0 };
    expect(computeCounterRate(first, coalescedLast)).toEqual({ rxRate: 10, txRate: 0 });
  });

  test("returns null on a counter reset (negative difference)", () => {
    // Agent restart rewinds the cumulative counter; a negative diff must not be
    // reported as a rate. Differencing degrades to null for that one frame.
    const prev = { tsMs: 0, rx: 5_000, tx: 5_000 };
    const next = { tsMs: 10_000, rx: 100, tx: 100 };
    expect(computeCounterRate(prev, next)).toEqual({ rxRate: null, txRate: null });
  });

  test("handles rx and tx independently", () => {
    // rx advances, tx counter resets: only tx degrades to null.
    const prev = { tsMs: 0, rx: 1_000, tx: 9_000 };
    const next = { tsMs: 10_000, rx: 1_500, tx: 10 };
    expect(computeCounterRate(prev, next)).toEqual({ rxRate: 50, txRate: null });
  });

  test("returns null for a non-positive interval", () => {
    const prev = { tsMs: 10_000, rx: 100, tx: 100 };
    const next = { tsMs: 10_000, rx: 200, tx: 200 };
    expect(computeCounterRate(prev, next)).toEqual({ rxRate: null, txRate: null });
  });
});

describe("computeDeltaRate", () => {
  test("returns null components without a previous timestamp", () => {
    expect(computeDeltaRate(null, { tsMs: 1_000, deltaRx: 100, deltaTx: 200 })).toEqual({
      rxRate: null,
      txRate: null,
    });
  });

  test("rate is the per-sample byte delta over elapsed seconds", () => {
    expect(computeDeltaRate(0, { tsMs: 10_000, deltaRx: 100, deltaTx: 200 })).toEqual({
      rxRate: 10,
      txRate: 20,
    });
  });

  test("returns null on a negative delta (counter reset)", () => {
    expect(computeDeltaRate(0, { tsMs: 10_000, deltaRx: -5, deltaTx: 50 })).toEqual({
      rxRate: null,
      txRate: 5,
    });
  });

  test("returns null for a non-positive interval", () => {
    expect(computeDeltaRate(10_000, { tsMs: 10_000, deltaRx: 100, deltaTx: 100 })).toEqual({
      rxRate: null,
      txRate: null,
    });
  });
});

describe("deriveTrafficRates", () => {
  test("prefers absolute counters (v2) when present on both samples", () => {
    // deltaRx would give 100/10 = 10, but the counter diff of 300 over 10s wins,
    // proving the v2 path (robust to coalesced frames) is chosen.
    const prev = { tsMs: 0, rx: 1_000, tx: 2_000 };
    const next = { tsMs: 10_000, rx: 1_300, tx: 2_600, deltaRx: 100, deltaTx: 100 };
    expect(deriveTrafficRates(prev, next)).toEqual({ rxRate: 30, txRate: 60 });
  });

  test("falls back to per-sample deltas (v1) when counters are absent", () => {
    const prev = { tsMs: 0 };
    const next = { tsMs: 10_000, deltaRx: 100, deltaTx: 200 };
    expect(deriveTrafficRates(prev, next)).toEqual({ rxRate: 10, txRate: 20 });
  });

  test("uses deltas when the previous sample lacks counters (v1 -> v2 transition)", () => {
    const prev = { tsMs: 0 };
    const next = { tsMs: 10_000, rx: 5_000, tx: 6_000, deltaRx: 100, deltaTx: 200 };
    expect(deriveTrafficRates(prev, next)).toEqual({ rxRate: 10, txRate: 20 });
  });

  test("returns null components on the very first sample", () => {
    expect(deriveTrafficRates(null, { tsMs: 1_000, deltaRx: 100, deltaTx: 200 })).toEqual({
      rxRate: null,
      txRate: null,
    });
  });
});
