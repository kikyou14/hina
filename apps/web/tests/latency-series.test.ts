import { describe, expect, test } from "bun:test";

import { buildLatencySeries, computeMedianIntervalMs } from "../src/pages/public/lib/latencyChart";
describe("buildLatencySeries", () => {
  test("preserves explicit null samples as breakpoints", () => {
    expect(
      buildLatencySeries(
        [
          { t: 0, value: 12 },
          { t: 60_000, value: null },
          { t: 120_000, value: 18 },
        ],
        60_000,
      ),
    ).toEqual([
      { t: 0, value: 12 },
      { t: 60_000, value: null },
      { t: 120_000, value: 18 },
    ]);
  });

  test("inserts a null marker when samples skip more than two intervals", () => {
    expect(
      buildLatencySeries(
        [
          { t: 0, value: 10 },
          { t: 60_000, value: 20 },
          { t: 240_000, value: 40 },
        ],
        60_000,
      ),
    ).toEqual([
      { t: 0, value: 10 },
      { t: 60_000, value: 20 },
      { t: 120_000, value: null },
      { t: 240_000, value: 40 },
    ]);
  });
});

describe("computeMedianIntervalMs", () => {
  test("uses the median spacing for irregular raw samples", () => {
    expect(computeMedianIntervalMs([0, 60_000, 120_000, 360_000, 420_000])).toBe(60_000);
  });
});
