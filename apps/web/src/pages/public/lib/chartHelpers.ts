import type { TimeSeriesPoint } from "@/components/charts/TimeSeriesLineChart";
import { formatPct, formatRateBytesPerSec } from "@/lib/format";
import type { MetricWindow } from "./timeWindows";

export type TrafficRate = {
  rxRate: number | null;
  txRate: number | null;
  updatedAtMs: number;
};

export type AgentSeriesPoint = {
  t: number;
  s: number;
  rx: number;
  tx: number;
  m: Record<string, number>;
};

export const LIVE_BUFFER_MAX_MS = 10 * 60 * 1000;
export const LIVE_BUFFER_FLUSH_INTERVAL_MS = 2 * 1000;

export function clampFinite(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

export function metricsToChartPoint(t: number, metrics: Record<string, number>): TimeSeriesPoint {
  return {
    t,
    cpuPct: clampFinite(metrics["cpu.usage_pct"]),
    memUsedPct: clampFinite(metrics["mem.used_pct"]),
    diskUsedPct: clampFinite(metrics["disk.used_pct"]),
    procCount: clampFinite(metrics["proc.count"]),
    connTcp: clampFinite(metrics["conn.tcp.count"]),
    connUdp: clampFinite(metrics["conn.udp.count"]),
    rxRate: clampFinite(metrics["net.rx_rate"]),
    txRate: clampFinite(metrics["net.tx_rate"]),
  };
}

export function computeBucketRate(bytes: number, intervalSec: number): number | null {
  if (!Number.isFinite(bytes) || !Number.isFinite(intervalSec) || intervalSec <= 0) return null;
  return bytes / intervalSec;
}

export function rollupPointToChartPoint(p: AgentSeriesPoint, intervalSec: number): TimeSeriesPoint {
  return {
    t: p.t,
    cpuPct: clampFinite(p.m["cpu.usage_pct"]),
    memUsedPct: clampFinite(p.m["mem.used_pct"]),
    diskUsedPct: clampFinite(p.m["disk.used_pct"]),
    procCount: clampFinite(p.m["proc.count"]),
    connTcp: clampFinite(p.m["conn.tcp.count"]),
    connUdp: clampFinite(p.m["conn.udp.count"]),
    rxRate: clampFinite(p.m["net.rx_rate"]) ?? computeBucketRate(p.rx, intervalSec),
    txRate: clampFinite(p.m["net.tx_rate"]) ?? computeBucketRate(p.tx, intervalSec),
  };
}

export function emptyChartPoint(t: number): TimeSeriesPoint {
  return metricsToChartPoint(t, {});
}

export function gapFillChartPoints(
  points: TimeSeriesPoint[],
  fromMs: number,
  toMs: number,
  intervalSec: number,
): TimeSeriesPoint[] {
  if (intervalSec <= 0 || points.length === 0) return points;
  const intervalMs = intervalSec * 1000;
  const byTs = new Map<number, TimeSeriesPoint>();
  for (const p of points) byTs.set(p.t, p);
  const startBucket = Math.floor(fromMs / intervalMs) * intervalMs;
  const endBucket = Math.floor(toMs / intervalMs) * intervalMs;
  const result: TimeSeriesPoint[] = [];
  for (let t = startBucket; t <= endBucket; t += intervalMs) {
    result.push(byTs.get(t) ?? emptyChartPoint(t));
  }
  return result;
}

function buildNetworkChartPoint(t: number, rxBytes: number, txBytes: number, intervalSec: number): TimeSeriesPoint {
  const point = emptyChartPoint(t);
  point.rxRate = computeBucketRate(rxBytes, intervalSec);
  point.txRate = computeBucketRate(txBytes, intervalSec);
  return point;
}

function getCompactNetworkPointBudget(w: MetricWindow): number | null {
  switch (w) {
    case "4h": return 48;
    case "1d": return 72;
    case "7d": return 84;
    case "30d": return 90;
    default: return null;
  }
}

export function buildCompactNetworkChartData(args: {
  points: AgentSeriesPoint[];
  fromMs: number;
  toMs: number;
  sourceIntervalSec: number;
  window: MetricWindow;
}): TimeSeriesPoint[] {
  if (args.points.length === 0) return [];
  const targetPoints = getCompactNetworkPointBudget(args.window);
  let targetIntervalSec = args.sourceIntervalSec;
  if (targetPoints !== null) {
    const spanSec = Math.max(1, Math.ceil((args.toMs - args.fromMs) / 1000));
    const rawTargetIntervalSec = Math.ceil(spanSec / targetPoints);
    targetIntervalSec = Math.max(
      args.sourceIntervalSec,
      Math.ceil(rawTargetIntervalSec / args.sourceIntervalSec) * args.sourceIntervalSec,
    );
  }
  if (targetIntervalSec === args.sourceIntervalSec) {
    const basePoints = args.points.map((point) =>
      buildNetworkChartPoint(point.t, point.rx, point.tx, args.sourceIntervalSec),
    );
    return gapFillChartPoints(basePoints, args.fromMs, args.toMs, args.sourceIntervalSec);
  }
  const targetIntervalMs = targetIntervalSec * 1000;
  const buckets = new Map<number, { rx: number; tx: number }>();
  for (const point of args.points) {
    const bucketStartMs = Math.floor(point.t / targetIntervalMs) * targetIntervalMs;
    const bucket = buckets.get(bucketStartMs) ?? { rx: 0, tx: 0 };
    bucket.rx += point.rx;
    bucket.tx += point.tx;
    buckets.set(bucketStartMs, bucket);
  }
  const rolledPoints = [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([t, bucket]) => buildNetworkChartPoint(t, bucket.rx, bucket.tx, targetIntervalSec));
  return gapFillChartPoints(rolledPoints, args.fromMs, args.toMs, targetIntervalSec);
}

export function formatLocalDateTime(tsMs: number, timezone?: string): string {
  return new Date(tsMs).toLocaleString(undefined, { timeZone: timezone });
}

export function formatCount(value: number): string {
  return String(Math.round(value));
}

export function formatRateBytesPerSecNumber(value: number): string {
  return formatRateBytesPerSec(value).replace(" ", "");
}

export function formatMsNumber(value: number): string {
  return `${Math.round(value)} ms`;
}

export function formatPctNumber(value: number): string {
  return formatPct(value);
}

export function normalizeArchLabel(arch: string | null | undefined): string | null {
  if (!arch) return null;
  const normalized = arch.trim().toLowerCase();
  if (normalized === "x86_64") return "amd64";
  if (normalized === "aarch64") return "arm64";
  return arch;
}
