export type TimeAxisFormat = "time-with-seconds" | "time" | "date";

export type TimeWindowOption<T extends string> = {
  label: string;
  value: T;
};

type TimeWindowConfig = {
  label: string;
  rangeMs: number;
  axisFormat: TimeAxisFormat;
};

export type MetricWindow = "live" | "4h" | "1d" | "7d" | "30d";

const METRIC_WINDOW_CONFIG = {
  live: { label: "Live", rangeMs: 3 * 60 * 1000, axisFormat: "time-with-seconds" },
  "4h": { label: "4H", rangeMs: 4 * 60 * 60 * 1000, axisFormat: "time" },
  "1d": { label: "1D", rangeMs: 24 * 60 * 60 * 1000, axisFormat: "time" },
  "7d": { label: "7D", rangeMs: 7 * 24 * 60 * 60 * 1000, axisFormat: "date" },
  "30d": { label: "30D", rangeMs: 30 * 24 * 60 * 60 * 1000, axisFormat: "date" },
} as const satisfies Record<MetricWindow, TimeWindowConfig>;

export const METRIC_WINDOWS = [
  { label: METRIC_WINDOW_CONFIG.live.label, value: "live" },
  { label: METRIC_WINDOW_CONFIG["4h"].label, value: "4h" },
  { label: METRIC_WINDOW_CONFIG["1d"].label, value: "1d" },
  { label: METRIC_WINDOW_CONFIG["7d"].label, value: "7d" },
  { label: METRIC_WINDOW_CONFIG["30d"].label, value: "30d" },
] as const satisfies readonly TimeWindowOption<MetricWindow>[];

export type LatencyWindow = "1h" | "6h" | "12h" | "1d" | "7d" | "30d";

const LATENCY_WINDOW_CONFIG = {
  "1h": { label: "1H", rangeMs: 60 * 60 * 1000, axisFormat: "time" },
  "6h": { label: "6H", rangeMs: 6 * 60 * 60 * 1000, axisFormat: "time" },
  "12h": { label: "12H", rangeMs: 12 * 60 * 60 * 1000, axisFormat: "time" },
  "1d": { label: "1D", rangeMs: 24 * 60 * 60 * 1000, axisFormat: "time" },
  "7d": { label: "7D", rangeMs: 7 * 24 * 60 * 60 * 1000, axisFormat: "date" },
  "30d": { label: "30D", rangeMs: 30 * 24 * 60 * 60 * 1000, axisFormat: "date" },
} as const satisfies Record<LatencyWindow, TimeWindowConfig>;

export const LATENCY_WINDOWS = [
  { label: LATENCY_WINDOW_CONFIG["1h"].label, value: "1h" },
  { label: LATENCY_WINDOW_CONFIG["6h"].label, value: "6h" },
  { label: LATENCY_WINDOW_CONFIG["12h"].label, value: "12h" },
  { label: LATENCY_WINDOW_CONFIG["1d"].label, value: "1d" },
  { label: LATENCY_WINDOW_CONFIG["7d"].label, value: "7d" },
  { label: LATENCY_WINDOW_CONFIG["30d"].label, value: "30d" },
] as const satisfies readonly TimeWindowOption<LatencyWindow>[];

function createTimeAxisFormatter(
  axisFormat: TimeAxisFormat,
  timezone?: string,
): (tsMs: number) => string {
  const opts: Intl.DateTimeFormatOptions = { timeZone: timezone };
  const formatter =
    axisFormat === "time-with-seconds"
      ? new Intl.DateTimeFormat(undefined, { ...opts, hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : axisFormat === "date"
        ? new Intl.DateTimeFormat(undefined, { ...opts, month: "2-digit", day: "2-digit" })
        : new Intl.DateTimeFormat(undefined, { ...opts, hour: "2-digit", minute: "2-digit" });

  return (tsMs) => formatter.format(tsMs);
}

export function getMetricWindowRangeMs(window: MetricWindow): number {
  return METRIC_WINDOW_CONFIG[window].rangeMs;
}

export function getLatencyWindowRangeMs(window: LatencyWindow): number {
  return LATENCY_WINDOW_CONFIG[window].rangeMs;
}

export function getMetricTimeAxisFormatter(
  window: MetricWindow,
  timezone?: string,
): (tsMs: number) => string {
  return createTimeAxisFormatter(METRIC_WINDOW_CONFIG[window].axisFormat, timezone);
}

export function getLatencyTimeAxisFormatter(
  window: LatencyWindow,
  timezone?: string,
): (tsMs: number) => string {
  return createTimeAxisFormatter(LATENCY_WINDOW_CONFIG[window].axisFormat, timezone);
}
