import { motion } from "motion/react";
import * as React from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import { ChartPlaceholder, type ChartPlaceholderStatus } from "@/components/charts/ChartPlaceholder";
import type { TimeSeriesPoint } from "@/components/charts/TimeSeriesLineChart";
import { computeNiceDomain } from "@/components/charts/TimeSeriesLineChart";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { usePublicAgentSeries } from "@/queries/public";

import type { LiveSeedStatus } from "../hooks/useLiveMetricBuffer";

import {
  buildCompactNetworkChartData,
  formatLocalDateTime,
  gapFillChartPoints,
  rollupPointToChartPoint,
} from "../lib/chartHelpers";
import {
  getMetricTimeAxisFormatter,
  getMetricWindowRangeMs,
  METRIC_WINDOWS,
  type MetricWindow,
  type TimeWindowOption,
} from "../lib/timeWindows";

export function TimeRangeSelector<T extends string>(props: {
  value: T;
  onChange: (w: T) => void;
  windows: readonly TimeWindowOption<T>[];
}) {
  const layoutId = React.useId();

  return (
    <div className="hina-time-range-selector flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {props.windows.map((r) => (
        <button
          key={r.value}
          onClick={() => props.onChange(r.value)}
          className={`relative rounded-md px-2 py-1 font-mono text-[10px] font-medium tracking-wide transition-colors ${
            props.value === r.value
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="relative z-10">{r.label}</span>
          {props.value === r.value && (
            <motion.span
              layoutId={layoutId}
              className="absolute inset-0 rounded-md bg-background shadow-sm dark:border dark:border-input dark:bg-input/30"
              transition={{ type: "spring", bounce: 0.15, duration: 0.5 }}
            />
          )}
        </button>
      ))}
    </div>
  );
}

export type AreaChartConfig = {
  agentId: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  color2?: string;
  dataKey: string;
  dataKey2?: string;
  dataKeyLabel?: string;
  dataKey2Label?: string;
  currentValue: React.ReactNode;
  liveBuffer: readonly TimeSeriesPoint[];
  liveSeedStatus: LiveSeedStatus;
  domainMax?: number;
  yTickFormatter: (v: number) => string;
  tooltipValueFormatter?: (v: number) => string;
  isNetwork?: boolean;
};

const AXIS_TICK_FILL = "var(--color-muted-foreground)";

type ChartState =
  | { kind: "ready"; data: readonly TimeSeriesPoint[] }
  | { kind: ChartPlaceholderStatus };

function MetricAreaChart(props: AreaChartConfig) {
  const { timezone } = useSiteConfig();
  const [chartWindow, setChartWindow] = React.useState<MetricWindow>("live");
  const [rangeEndMs, setRangeEndMs] = React.useState(() => Date.now());
  const Icon = props.icon;

  React.useEffect(() => {
    setRangeEndMs(Date.now());
  }, [chartWindow, props.agentId]);

  const rangeMs = getMetricWindowRangeMs(chartWindow);
  const fromMs = rangeEndMs - rangeMs;
  const toMs = rangeEndMs;

  const activeSeries = usePublicAgentSeries(
    { agentId: props.agentId, fromMs, toMs, resolution: "auto", maxPoints: 2000 },
    chartWindow !== "live",
  );
  const seriesData = activeSeries.data;
  const seriesError = activeSeries.error;

  const chart = React.useMemo((): ChartState => {
    if (chartWindow === "live") {
      if (props.liveBuffer.length >= 2) return { kind: "ready", data: props.liveBuffer };
      if (props.liveSeedStatus === "error") return { kind: "error" };
      if (props.liveSeedStatus === "loading") return { kind: "loading" };
      return { kind: "empty" };
    }

    if (seriesError) return { kind: "error" };
    if (!seriesData) return { kind: "loading" };
    if (!seriesData.ok) return { kind: "error" };

    const data = props.isNetwork
      ? buildCompactNetworkChartData({
          points: seriesData.points,
          fromMs: seriesData.fromMs,
          toMs: seriesData.toMs,
          sourceIntervalSec: seriesData.intervalSec,
          window: chartWindow,
        })
      : gapFillChartPoints(
          seriesData.points.map((p) => rollupPointToChartPoint(p, seriesData.intervalSec)),
          seriesData.fromMs,
          seriesData.toMs,
          seriesData.intervalSec,
        );

    const hasAnyValue = data.some((p) => {
      const v1 = p[props.dataKey];
      const v2 = props.dataKey2 ? p[props.dataKey2] : null;
      return typeof v1 === "number" || typeof v2 === "number";
    });
    if (!hasAnyValue) return { kind: "empty" };

    return { kind: "ready", data };
  }, [
    chartWindow,
    props.liveBuffer,
    props.liveSeedStatus,
    props.isNetwork,
    props.dataKey,
    props.dataKey2,
    seriesData,
    seriesError,
  ]);

  const xTickFormatter = React.useMemo(
    () => getMetricTimeAxisFormatter(chartWindow, timezone),
    [chartWindow, timezone],
  );

  const yDomain = React.useMemo((): [number, number] => {
    if (chart.kind !== "ready") return [0, props.domainMax ?? 1];
    if (props.domainMax !== undefined) {
      const keys = props.dataKey2 ? [props.dataKey, props.dataKey2] : [props.dataKey];
      return computeNiceDomain(chart.data as TimeSeriesPoint[], keys, 0, props.domainMax);
    }
    let max = 0;
    for (const p of chart.data) {
      const v1 = p[props.dataKey];
      const v2 = props.dataKey2 ? p[props.dataKey2] : null;
      if (typeof v1 === "number" && v1 > max) max = v1;
      if (typeof v2 === "number" && v2 > max) max = v2;
    }
    return [0, max > 0 ? max * 1.2 : 1];
  }, [chart, props.dataKey, props.dataKey2, props.domainMax]);

  const gradId = props.title.replace(/\s+/g, "-").toLowerCase();
  const tooltipFormatter = props.tooltipValueFormatter ?? props.yTickFormatter;

  return (
    <div className="hina-metric-card overflow-hidden rounded-xl border border-border bg-card backdrop-blur-sm">
      <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3 sm:px-5 sm:py-3.5">
        <div className="flex flex-1 items-center justify-between gap-2 sm:gap-3">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              <Icon className="size-4" />
            </span>
            <h3 className="stat-label font-semibold">{props.title}</h3>
          </div>
          <span className="stat-value font-mono font-semibold">{props.currentValue}</span>
        </div>
        <div className="self-end sm:self-auto">
          <TimeRangeSelector value={chartWindow} onChange={setChartWindow} windows={METRIC_WINDOWS} />
        </div>
      </div>

      <div className="p-2 pt-1">
        {chart.kind !== "ready" ? (
          <div style={{ height: 180 }}>
            <ChartPlaceholder status={chart.kind} />
          </div>
        ) : (
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={chart.data as TimeSeriesPoint[]} margin={{ top: 10, right: 4, left: -12, bottom: 0 }}>
            <defs>
              <linearGradient id={`grad-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={props.color} stopOpacity={0.2} />
                <stop offset="100%" stopColor={props.color} stopOpacity={0} />
              </linearGradient>
              {props.color2 ? (
                <linearGradient id={`grad2-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={props.color2} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={props.color2} stopOpacity={0} />
                </linearGradient>
              ) : null}
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="color-mix(in oklch, var(--color-muted-foreground) 12%, transparent)"
            />
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={{ fill: AXIS_TICK_FILL, fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
              minTickGap={40}
              tickFormatter={(v) => xTickFormatter(Number(v))}
            />
            <YAxis
              tick={{ fill: AXIS_TICK_FILL, fontSize: 10, dx: 6 }}
              tickLine={false}
              axisLine={false}
              domain={yDomain}
              tickFormatter={(v) => props.yTickFormatter(Number(v))}
            />
            <Tooltip
              labelFormatter={(label) => formatLocalDateTime(Number(label), timezone)}
              formatter={(raw, name) => [
                typeof raw === "number" ? tooltipFormatter(raw) : "-",
                String(name),
              ]}
              contentStyle={{
                borderRadius: "8px",
                fontSize: "11px",
                fontFamily: "ui-monospace, monospace",
                border: "1px solid var(--color-border)",
                backgroundColor: "var(--color-card)",
              }}
            />
            <Area
              type="monotone"
              dataKey={props.dataKey}
              stroke={props.color}
              strokeWidth={1.5}
              fill={`url(#grad-${gradId})`}
              name={props.dataKeyLabel ?? props.title}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0, fill: props.color }}
              isAnimationActive={false}
              connectNulls={false}
            />
            {props.color2 && props.dataKey2 ? (
              <Area
                type="monotone"
                dataKey={props.dataKey2}
                stroke={props.color2}
                strokeWidth={1.5}
                fill={`url(#grad2-${gradId})`}
                name={props.dataKey2Label ?? ""}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0, fill: props.color2 }}
                isAnimationActive={false}
                connectNulls={false}
              />
            ) : null}
          </AreaChart>
        </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

export const MemoMetricAreaChart = React.memo(MetricAreaChart);
