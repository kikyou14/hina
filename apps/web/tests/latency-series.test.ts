import { describe, expect, test } from "bun:test";

import {
  buildLatencySeries,
  computeMedianIntervalMs,
  type LatencySeriesPoint,
  smoothLatencySeries,
} from "../src/pages/public/lib/latencyChart";
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
      { t: 120_000, value: null, gap: true },
      { t: 240_000, value: 40 },
    ]);
  });
});

describe("computeMedianIntervalMs", () => {
  test("uses the median spacing for irregular raw samples", () => {
    expect(computeMedianIntervalMs([0, 60_000, 120_000, 360_000, 420_000])).toBe(60_000);
  });
});

const SMOOTH_INTERVAL_MS = 1000;

function makeSeries(values: ReadonlyArray<number | null>, startT = 0): LatencySeriesPoint[] {
  return values.map((value, index) => ({ t: startT + index * SMOOTH_INTERVAL_MS, value }));
}

function valuesOf(points: readonly LatencySeriesPoint[]): Array<number | null> {
  return points.map((point) => point.value);
}

describe("smoothLatencySeries", () => {
  test("returns empty input unchanged", () => {
    expect(smoothLatencySeries([])).toEqual([]);
  });

  test("returns short series unchanged", () => {
    expect(valuesOf(smoothLatencySeries(makeSeries([10, 1000])))).toEqual([10, 1000]);
  });

  test("returns an all-null series unchanged", () => {
    expect(valuesOf(smoothLatencySeries(makeSeries([null, null, null])))).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("keeps timestamps and length, does not mutate input", () => {
    const input = makeSeries([10, 500, 10, 10, 10]);
    const snapshot = structuredClone(input);
    const output = smoothLatencySeries(input);
    expect(output.map((point) => point.t)).toEqual(input.map((point) => point.t));
    expect(output).toHaveLength(input.length);
    expect(input).toEqual(snapshot);
  });

  test("removes an isolated one-point spike", () => {
    const output = smoothLatencySeries(makeSeries([10, 10, 10, 1000, 10, 10, 10]));
    expect(valuesOf(output)).toEqual([10, 10, 10, 10, 10, 10, 10]);
  });

  test("removes a two-point spike with the default window", () => {
    const output = smoothLatencySeries(makeSeries([10, 10, 10, 1000, 1000, 10, 10, 10]));
    expect(valuesOf(output)).toEqual([10, 10, 10, 10, 10, 10, 10, 10]);
  });

  test("preserves a sustained three-point elevation", () => {
    const output = smoothLatencySeries(makeSeries([10, 10, 1000, 1000, 1000, 10, 10]));
    expect(valuesOf(output)).toEqual([10, 10, 1000, 1000, 1000, 10, 10]);
  });

  test("keeps step changes sharp without inventing intermediate values", () => {
    const output = smoothLatencySeries(makeSeries([10, 10, 10, 10, 100, 100, 100, 100]));
    expect(valuesOf(output)).toEqual([10, 10, 10, 10, 100, 100, 100, 100]);
  });

  test("preserves nulls and smooths around them", () => {
    const output = smoothLatencySeries(makeSeries([10, null, 10, 12, 10]));
    expect(valuesOf(output)).toEqual([10, null, 10, 10, 10]);
  });

  test("does not invent intermediate values when a null makes the window even", () => {
    // Filtering the null out of the centered window leaves 4 values; the even
    // median must not average the middle pair (505) but keep a real sample.
    expect(valuesOf(smoothLatencySeries(makeSeries([10, null, 10, 1000, 1000])))).toEqual([
      10,
      null,
      10,
      1000,
      1000,
    ]);
    expect(valuesOf(smoothLatencySeries(makeSeries([10, 10, 1000, null, 1000])))).toEqual([
      10,
      10,
      1000,
      null,
      1000,
    ]);
  });

  test("keeps levels distinct across a gap without inventing intermediate values", () => {
    // The window crosses gaps, but the median plus the closest-sample
    // tie-break keeps each side at its own level instead of blending them.
    // The failure-flanked straggler before the gap merges into the outage.
    const left = makeSeries([10, 10, null, null, 10]);
    const gapMarker: LatencySeriesPoint = { t: 5_000, value: null, gap: true };
    const right = makeSeries([500, 500, 500, 500, 500], 60_000);
    const output = smoothLatencySeries([...left, gapMarker, ...right]);
    expect(valuesOf(output)).toEqual([10, 10, null, null, null, null, 500, 500, 500, 500, 500]);
  });

  test("smooths an isolated spike before a time gap using both sides", () => {
    const left = makeSeries([10, 10, 1000]);
    const right = makeSeries([10, 10, 10, 10], 60_000);
    const output = smoothLatencySeries([...left, ...right]);
    expect(valuesOf(output)).toEqual([10, 10, 10, 10, 10, 10, 10]);
  });

  test("smooths an isolated spike right before a gap marker", () => {
    // The marker occupies a window slot without contributing a value; it must
    // not shield the preceding spike from the samples across the outage.
    const left = makeSeries([10, 10, 1000]);
    const gapMarker: LatencySeriesPoint = { t: 3_000, value: null, gap: true };
    const right = makeSeries([10, 10, 10, 10], 60_000);
    const output = smoothLatencySeries([...left, gapMarker, ...right]);
    expect(valuesOf(output)).toEqual([10, 10, 10, null, 10, 10, 10, 10]);
  });

  test("smooths a spike before a short gap that only the marker reveals", () => {
    // Real gap of exactly 3 intervals: the marker sits 1 interval after the
    // last sample before the outage and still takes part in the window.
    const series = buildLatencySeries(
      [
        { t: 0, value: 10 },
        { t: 1_000, value: 10 },
        { t: 2_000, value: 1000 },
        { t: 5_000, value: 10 },
        { t: 6_000, value: 10 },
        { t: 7_000, value: 10 },
      ],
      1_000,
    );
    const output = smoothLatencySeries(series);
    expect(valuesOf(output)).toEqual([10, 10, 10, null, 10, 10, 10]);
  });

  test("nulls an isolated success surrounded by failed probes", () => {
    // One high-latency success inside a run of failures has no valid
    // neighbors to smooth against; it must merge into the outage instead of
    // surviving and stretching the Y axis.
    const output = smoothLatencySeries(
      makeSeries([10, 10, 10, null, null, 1000, null, null, 10, 10, 10]),
    );
    expect(valuesOf(output)).toEqual([10, 10, 10, null, null, null, null, null, 10, 10, 10]);
  });

  test("smooths an outage-edge spike toward the healthy side", () => {
    const output = smoothLatencySeries(makeSeries([10, 10, 1000, null, null, null, 10, 10]));
    expect(valuesOf(output)).toEqual([10, 10, 10, null, null, null, 10, 10]);
  });

  test("preserves a sustained degradation cluster inside an outage", () => {
    const output = smoothLatencySeries(makeSeries([null, null, 900, 1000, 1100, null, null]));
    expect(valuesOf(output)).toEqual([null, null, 1000, 1000, 1000, null, null]);
  });

  test("keeps values when valid samples reach half of the window", () => {
    const output = smoothLatencySeries(makeSeries([10, null, 12, null, 10]));
    expect(valuesOf(output)).toEqual([10, null, 10, null, 10]);
  });

  test("smooths a spike right after a gap marker", () => {
    // First probe after an outage often carries an elevated latency; it must
    // be judged against neighbors across the gap instead of passing through.
    const left = makeSeries([10, 10]);
    const gapMarker: LatencySeriesPoint = { t: 2_000, value: null, gap: true };
    const right = makeSeries([1000, 10, 10], 60_000);
    const output = smoothLatencySeries([...left, gapMarker, ...right]);
    expect(valuesOf(output)).toEqual([10, 10, null, 10, 10, 10]);
  });

  test("wider windows remove longer spikes", () => {
    const spike = makeSeries([10, 10, 10, 1000, 1000, 1000, 10, 10, 10]);
    expect(valuesOf(smoothLatencySeries(spike, 5))).toEqual([
      10, 10, 10, 1000, 1000, 1000, 10, 10, 10,
    ]);
    expect(valuesOf(smoothLatencySeries(spike, 7))).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 10]);
  });
});
