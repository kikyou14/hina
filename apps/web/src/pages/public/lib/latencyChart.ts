import type { PublicProbeSeriesResponse, PublicProbeSeriesTier } from "@/api/public";

import type { LatencyWindow } from "./timeWindows";
import { getLatencyWindowRangeMs } from "./timeWindows";

export type LatencySeriesPoint = {
  t: number;
  value: number | null;
  gap?: true;
};

export type ProbeTaskStats = {
  median: number | null;
  min: number | null;
  max: number | null;
  lossAvg: number | null;
  jitterAvg: number | null;
};

type ResolvedProbeSeriesTier = Extract<PublicProbeSeriesTier, "raw" | "hourly" | "daily">;

export type LatencyQueryPolicy = {
  tier: ResolvedProbeSeriesTier;
  maxPoints: number;
};

export const PROBE_LINE_COLORS = ["#10b981", "#06b6d4", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"] as const;

export const EMPTY_PROBE_TASK_STATS: ProbeTaskStats = {
  median: null,
  min: null,
  max: null,
  lossAvg: null,
  jitterAvg: null,
};

const RAW_PROBE_MAX_POINTS = 50_000;
const ROLLUP_PROBE_MAX_POINTS = 20_000;

function medianOfSorted(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function computeMedianIntervalMs(timestamps: readonly number[]): number | null {
  if (timestamps.length < 2) return null;

  const deltas: number[] = [];
  for (let i = 1; i < timestamps.length; i += 1) {
    deltas.push(timestamps[i]! - timestamps[i - 1]!);
  }

  deltas.sort((a, b) => a - b);
  const median = medianOfSorted(deltas);
  return median > 0 ? median : null;
}

function insertGapMarkers<T extends { t: number }>(
  points: readonly T[],
  knownIntervalMs: number | null,
  mkNull: (t: number) => T,
): T[] {
  if (points.length < 2) return [...points];

  let intervalMs = knownIntervalMs;
  if (intervalMs === null) {
    const deltas: number[] = [];
    for (let i = 1; i < points.length; i += 1) {
      deltas.push(points[i]!.t - points[i - 1]!.t);
    }
    deltas.sort((a, b) => a - b);
    intervalMs = medianOfSorted(deltas);
  }

  if (intervalMs <= 0) return [...points];

  const gapThreshold = intervalMs * 2;
  const result: T[] = [points[0]!];

  for (let i = 1; i < points.length; i += 1) {
    if (points[i]!.t - points[i - 1]!.t > gapThreshold) {
      result.push(mkNull(points[i - 1]!.t + intervalMs));
    }
    result.push(points[i]!);
  }

  return result;
}

export function buildLatencySeries(
  points: readonly LatencySeriesPoint[],
  knownIntervalMs: number | null,
): LatencySeriesPoint[] {
  if (points.length === 0) return [];
  return insertGapMarkers(points, knownIntervalMs, (t) => ({ t, value: null, gap: true }));
}

export function smoothLatencySeries(
  points: readonly LatencySeriesPoint[],
  windowSize = 5,
): LatencySeriesPoint[] {
  if (points.length < 3) return [...points];

  const maxRadius = windowSize >> 1;
  const intervalMs = computeMedianIntervalMs(points.map((point) => point.t));
  const gapThreshold = intervalMs === null ? Infinity : intervalMs * 2;
  const result: LatencySeriesPoint[] = new Array(points.length);

  const smoothSegment = (start: number, end: number) => {
    let first = start;
    while (first < end && points[first]!.value === null) {
      result[first] = points[first]!;
      first += 1;
    }
    let last = end - 1;
    while (last >= first && points[last]!.value === null) {
      result[last] = points[last]!;
      last -= 1;
    }
    for (let i = first; i <= last; i += 1) {
      const point = points[i]!;
      const current = point.value;
      if (current === null) {
        result[i] = point;
        continue;
      }
      const radius = Math.min(maxRadius, i - first, last - i);
      const values: number[] = [];
      for (let j = i - radius; j <= i + radius; j += 1) {
        const v = points[j]!.value;
        if (v !== null) values.push(v);
      }
      values.sort((a, b) => a - b);
      const mid = values.length >> 1;
      let median: number;
      if (values.length % 2 === 1) {
        median = values[mid]!;
      } else {
        const lo = values[mid - 1]!;
        const hi = values[mid]!;
        median = Math.abs(current - lo) <= Math.abs(current - hi) ? lo : hi;
      }
      result[i] = { t: point.t, value: median };
    }
  };

  let segmentStart = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i]!.gap === true || points[i]!.t - points[i - 1]!.t > gapThreshold) {
      smoothSegment(segmentStart, i);
      segmentStart = i;
    }
  }
  smoothSegment(segmentStart, points.length);

  return result;
}

function estimateRawPointCount(rangeMs: number, taskIntervalSec: number | null | undefined): number | null {
  if (taskIntervalSec === null || taskIntervalSec === undefined) return null;
  if (!Number.isFinite(taskIntervalSec) || taskIntervalSec <= 0) return null;
  return Math.ceil(rangeMs / (taskIntervalSec * 1000));
}

export function resolveLatencyQueryPolicy(
  window: LatencyWindow,
  taskIntervalSec: number | null | undefined,
): LatencyQueryPolicy {
  switch (window) {
    case "1h":
    case "6h":
    case "12h":
      return { tier: "raw", maxPoints: RAW_PROBE_MAX_POINTS };
    case "1d": {
      const estimatedRawPoints = estimateRawPointCount(getLatencyWindowRangeMs(window), taskIntervalSec);
      if (estimatedRawPoints !== null && estimatedRawPoints <= RAW_PROBE_MAX_POINTS) {
        return { tier: "raw", maxPoints: RAW_PROBE_MAX_POINTS };
      }
      return { tier: "hourly", maxPoints: ROLLUP_PROBE_MAX_POINTS };
    }
    case "7d":
      return { tier: "hourly", maxPoints: ROLLUP_PROBE_MAX_POINTS };
    case "30d":
      return { tier: "hourly", maxPoints: ROLLUP_PROBE_MAX_POINTS };
  }
}

export function buildLatencyChartSeries(series: PublicProbeSeriesResponse | undefined): LatencySeriesPoint[] {
  if (!series || series.ok !== true) return [];

  if (series.tier === "raw") {
    return buildLatencySeries(
      series.points.map((point) => ({ t: point.t, value: point.ok ? point.latMs : null })),
      computeMedianIntervalMs(series.points.map((point) => point.t)),
    );
  }

  return buildLatencySeries(
    series.points.map((point) => ({ t: point.t, value: point.latAvgMs })),
    series.intervalSec * 1000,
  );
}

export function buildLatencyStats(series: PublicProbeSeriesResponse | undefined): ProbeTaskStats {
  if (!series || series.ok !== true) return EMPTY_PROBE_TASK_STATS;

  if (series.tier === "raw") {
    const values: number[] = [];
    const lossValues: number[] = [];
    const jitterValues: number[] = [];

    for (const point of series.points) {
      if (point.ok && point.latMs !== null) values.push(point.latMs);
      if (point.lossPct !== null) lossValues.push(point.lossPct);
      if (point.jitterMs !== null) jitterValues.push(point.jitterMs);
    }

    if (values.length === 0) return EMPTY_PROBE_TASK_STATS;

    values.sort((a, b) => a - b);

    let lossSum = 0;
    for (const v of lossValues) lossSum += v;

    let jitterSum = 0;
    for (const v of jitterValues) jitterSum += v;

    return {
      median: medianOfSorted(values),
      min: values[0]!,
      max: values[values.length - 1]!,
      lossAvg: lossValues.length > 0 ? lossSum / lossValues.length : null,
      jitterAvg: jitterValues.length > 0 ? jitterSum / jitterValues.length : null,
    };
  }

  let weightedSum = 0;
  let totalLatSamples = 0;
  let min = Infinity;
  let max = -Infinity;
  let weightedLossSum = 0;
  let totalLossSamples = 0;
  let weightedJitSum = 0;
  let totalJitSamples = 0;

  for (const point of series.points) {
    if (point.latSamples > 0 && point.latAvgMs !== null) {
      weightedSum += point.latAvgMs * point.latSamples;
      totalLatSamples += point.latSamples;
    }
    if (point.latMinMs !== null && point.latMinMs < min) min = point.latMinMs;
    if (point.latMaxMs !== null && point.latMaxMs > max) max = point.latMaxMs;
    if (point.lossSamples > 0 && point.lossAvgPct !== null) {
      weightedLossSum += point.lossAvgPct * point.lossSamples;
      totalLossSamples += point.lossSamples;
    }
    if (point.jitSamples > 0 && point.jitAvgMs !== null) {
      weightedJitSum += point.jitAvgMs * point.jitSamples;
      totalJitSamples += point.jitSamples;
    }
  }

  if (totalLatSamples === 0) return EMPTY_PROBE_TASK_STATS;

  return {
    median: weightedSum / totalLatSamples,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
    lossAvg: totalLossSamples > 0 ? weightedLossSum / totalLossSamples : null,
    jitterAvg: totalJitSamples > 0 ? weightedJitSum / totalJitSamples : null,
  };
}
