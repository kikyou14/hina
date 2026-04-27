import * as React from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useSiteConfig } from "@/components/SiteConfigProvider";

export type TimeSeriesPoint = { t: number } & Record<string, number | null>;

export type TimeSeriesLineSpec = {
  key: string;
  name: string;
  stroke: string;
};

export type TimeSeriesLineChartVariant = "compact" | "default";

export type TimeSeriesLineChartProps = {
  data: readonly TimeSeriesPoint[];
  lines: readonly TimeSeriesLineSpec[];
  variant: TimeSeriesLineChartVariant;
  xTickFormatter: (tsMs: number) => string;
  yTickFormatter: (value: number) => string;
  yDomain?: [number | "auto", number | "auto"];
  lineType?: "monotone" | "linear";
  tooltipLabelFormatter?: (tsMs: number) => string;
  tooltipValueFormatter?: (value: number) => string;
};

const AXIS_TICK_FILL = "var(--color-muted-foreground)";
const GRID_STROKE = "color-mix(in oklch, var(--color-muted-foreground) 20%, transparent)";

const COMPACT_TICK_STYLE = { fontSize: 10, fill: AXIS_TICK_FILL } as const;
const DEFAULT_TICK_STYLE = { fontSize: 12, fill: AXIS_TICK_FILL } as const;

const COMPACT_MARGIN = { top: 14, right: 8, bottom: 0, left: 0 } as const;
const DEFAULT_MARGIN = { top: 16, right: 12, bottom: 0, left: 0 } as const;

export function createTooltipLabelFormatter(timezone?: string): (tsMs: number) => string {
  return (tsMs) => new Date(tsMs).toLocaleString(undefined, { timeZone: timezone });
}

function defaultTooltipValueFormatter(value: number): string {
  return String(value);
}

export function computeNiceDomain(
  data: readonly TimeSeriesPoint[],
  keys: readonly string[],
  min = 0,
  maxCap?: number,
): [number, number] {
  let dataMax = min;
  for (const point of data) {
    for (const key of keys) {
      const val = point[key];
      if (typeof val === "number" && val > dataMax) dataMax = val;
    }
  }

  if (dataMax <= min) return [min, maxCap ?? 1];

  const target = dataMax * 1.2;
  const exp = Math.floor(Math.log10(target));
  const base = 10 ** exp;
  const fraction = target / base;

  let nice: number;
  if (fraction <= 1) nice = 1;
  else if (fraction <= 2) nice = 2;
  else if (fraction <= 2.5) nice = 2.5;
  else if (fraction <= 5) nice = 5;
  else nice = 10;

  let niceMax = nice * base;
  if (maxCap !== undefined) niceMax = Math.min(niceMax, maxCap);

  return [min, niceMax];
}

export const TimeSeriesLineChart = React.memo(function TimeSeriesLineChart(
  props: TimeSeriesLineChartProps,
) {
  const { timezone } = useSiteConfig();
  const defaultLabelFormatter = React.useMemo(
    () => createTooltipLabelFormatter(timezone),
    [timezone],
  );
  const tooltipLabelFormatter = props.tooltipLabelFormatter ?? defaultLabelFormatter;
  const tooltipValueFormatter = props.tooltipValueFormatter ?? defaultTooltipValueFormatter;

  const tickStyle = props.variant === "compact" ? COMPACT_TICK_STYLE : DEFAULT_TICK_STYLE;
  const margin = props.variant === "compact" ? COMPACT_MARGIN : DEFAULT_MARGIN;
  const yDomain = props.yDomain ?? ["auto", "auto"];
  const lineType = props.lineType ?? "monotone";

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={props.data as unknown as TimeSeriesPoint[]} margin={margin}>
        <CartesianGrid stroke={GRID_STROKE} vertical={props.variant !== "compact"} />

        <XAxis
          dataKey="t"
          type="number"
          domain={["dataMin", "dataMax"]}
          tick={tickStyle}
          tickMargin={4}
          tickLine={false}
          axisLine={false}
          tickCount={props.variant === "compact" ? 3 : undefined}
          minTickGap={props.variant === "compact" ? 20 : 32}
          interval="preserveStartEnd"
          tickFormatter={(value) => props.xTickFormatter(Number(value))}
        />

        <YAxis
          domain={yDomain}
          tick={tickStyle}
          tickMargin={4}
          tickLine={false}
          axisLine={false}
          tickCount={props.variant === "compact" ? 3 : undefined}
          tickFormatter={(value) => props.yTickFormatter(Number(value))}
        />

        <Tooltip
          labelFormatter={(label) => tooltipLabelFormatter(Number(label))}
          formatter={(raw, name) => [
            typeof raw === "number" ? tooltipValueFormatter(raw) : "-",
            String(name),
          ]}
        />

        {props.lines.map((line) => (
          <Line
            key={line.key}
            type={lineType}
            dataKey={line.key}
            name={line.name}
            dot={false}
            strokeWidth={2}
            stroke={line.stroke}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
});
