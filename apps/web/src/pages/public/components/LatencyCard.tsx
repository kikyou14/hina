import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Globe } from "lucide-react";

import { ChartPlaceholder } from "@/components/charts/ChartPlaceholder";
import type { TimeSeriesLineSpec } from "@/components/charts/TimeSeriesLineChart";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { Toggle } from "@/components/ui/toggle";
import type { PublicAgentProbeLatestResponse } from "@/api/public";
import { getUserErrorMessage } from "@/lib/userErrors";

import {
  EMPTY_PROBE_TASK_STATS,
  type LatencySeriesPoint,
  PROBE_LINE_COLORS,
  type ProbeTaskStats,
} from "../lib/latencyChart";
import { formatLocalDateTime, formatMsNumber } from "../lib/chartHelpers";
import { LATENCY_WINDOWS, type LatencyWindow } from "../lib/timeWindows";
import { TimeRangeSelector } from "./MetricAreaChart";

type LatencyLineSpec = TimeSeriesLineSpec & { data: readonly LatencySeriesPoint[] };

function CustomTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number | null; color: string }>;
  label?: number;
}) {
  const { timezone } = useSiteConfig();
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card/95 px-3 py-2 shadow-xl backdrop-blur-sm">
      <p className="mb-1.5 text-xs text-muted-foreground">{formatLocalDateTime(Number(label), timezone)}</p>
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center gap-2 text-sm font-medium" style={{ color: entry.color }}>
          <span className="inline-block size-2 rounded-full" style={{ background: entry.color }} />
          {entry.name}: {typeof entry.value === "number" ? formatMsNumber(entry.value) : "-"}
        </p>
      ))}
    </div>
  );
}

const AXIS_TICK_FILL = "var(--color-muted-foreground)";

function LatencyLineChart(props: {
  data: readonly { t: number }[];
  lines: readonly LatencyLineSpec[];
  xTickFormatter: (tsMs: number) => string;
  symlog: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={props.data as Array<{ t: number }>} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="color-mix(in oklch, var(--color-muted-foreground) 8%, transparent)"
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
          tickFormatter={(v) => props.xTickFormatter(Number(v))}
        />
        <YAxis
          tick={{ fill: AXIS_TICK_FILL, fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => `${v} ms`}
          width={55}
          scale={props.symlog ? "symlog" : "auto"}
          domain={[0, "auto"]}
        />
        <Tooltip content={<CustomTooltip />} />
        <Legend
          iconType="circle"
          iconSize={6}
          wrapperStyle={{ fontSize: 11, color: "var(--color-muted-foreground)", paddingTop: 8 }}
        />
        {props.lines.map((l) => (
          <Line
            key={l.key}
            data={l.data as Array<LatencySeriesPoint>}
            type="linear"
            dataKey="value"
            stroke={l.stroke}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0, fill: l.stroke }}
            name={l.name}
            isAnimationActive={false}
            connectNulls={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

const MemoLatencyLineChart = React.memo(LatencyLineChart);

function formatLatencyStat(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(1)}ms`;
}

function LatencyStats(props: {
  selectedProbeTaskIds: string[];
  setSelectedProbeTaskIds: React.Dispatch<React.SetStateAction<string[]>>;
  latencyProbeResults: PublicAgentProbeLatestResponse["results"];
  statsByTaskId: ReadonlyMap<string, ProbeTaskStats>;
}) {
  const { t } = useTranslation();

  const toggleTask = (taskId: string) => {
    props.setSelectedProbeTaskIds((current) => {
      if (current.includes(taskId)) {
        if (current.length <= 1) return current;
        return current.filter((id) => id !== taskId);
      }
      return [...current, taskId];
    });
  };

  const entries = props.latencyProbeResults.map((r, idx) => {
    const taskId = r.task.id;
    const label = r.task.name ?? taskId.slice(0, 8);
    const color = PROBE_LINE_COLORS[idx % PROBE_LINE_COLORS.length]!;
    const selected = props.selectedProbeTaskIds.includes(taskId);
    const s = props.statsByTaskId.get(taskId) ?? EMPTY_PROBE_TASK_STATS;
    return { taskId, label, color, selected, ...s };
  });

  if (entries.length === 0) return null;

  return (
    <div className="border-t border-border/50 bg-muted/30 px-5 py-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {entries.map((s) => (
          <button
            key={s.taskId}
            type="button"
            onClick={() => toggleTask(s.taskId)}
            className={`flex items-center gap-3 rounded-lg px-2 py-1 text-left transition-all duration-200 hover:bg-muted/40 ${s.selected ? "" : "opacity-40"
              }`}
          >
            <span
              className="h-8 w-1 shrink-0 rounded-full"
              style={{ background: s.selected ? s.color : "var(--color-muted-foreground)" }}
            />
            <div>
              <p className="text-xs font-medium text-muted-foreground">{s.label}</p>
              {s.median !== null ? (
                <div>
                  <p className="font-mono text-xs text-muted-foreground/80">
                    {t("publicAgent.latency.statsMedian")}: <span style={{ color: s.color }}>{formatLatencyStat(s.median)}</span>
                    {" / "}
                    {t("publicAgent.latency.statsMin")}: {formatLatencyStat(s.min)}
                    {" / "}
                    {t("publicAgent.latency.statsMax")}: {formatLatencyStat(s.max)}
                  </p>
                  {(s.lossAvg !== null || s.jitterAvg !== null) && (
                    <p className="font-mono text-xs text-muted-foreground/60">
                      {s.lossAvg !== null && <>{t("publicAgent.latency.loss")}: {s.lossAvg.toFixed(1)}%</>}
                      {s.lossAvg !== null && s.jitterAvg !== null && " / "}
                      {s.jitterAvg !== null && <>{t("publicAgent.latency.jitter")}: {formatLatencyStat(s.jitterAvg)}</>}
                    </p>
                  )}
                </div>
              ) : (
                <p className="font-mono text-xs text-muted-foreground/60">-</p>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export type LatencyCardProps = {
  probeLatestLoading: boolean;
  probeLatestError: Error | null;
  allProbeResults: PublicAgentProbeLatestResponse["results"];
  latencyProbeResults: PublicAgentProbeLatestResponse["results"];
  selectedProbeTaskIds: string[];
  setSelectedProbeTaskIds: React.Dispatch<React.SetStateAction<string[]>>;
  latencyWindow: LatencyWindow;
  setLatencyWindow: React.Dispatch<React.SetStateAction<LatencyWindow>>;
  latencyChartData: readonly { t: number }[];
  latencyLines: readonly LatencyLineSpec[];
  latencyXTickFormatter: (tsMs: number) => string;
  latencyStatsByTaskId: ReadonlyMap<string, ProbeTaskStats>;
  latencySeriesLoading: boolean;
  firstProbeSeriesError: Error | null;
};

function getLatencyWindowLabel(window: LatencyWindow): string {
  return LATENCY_WINDOWS.find((option) => option.value === window)?.label ?? window.toUpperCase();
}

function LatencyLoadingOverlay(props: { window: LatencyWindow }) {
  const { t } = useTranslation();
  const windowLabel = getLatencyWindowLabel(props.window);

  return (
    <div className="absolute inset-0 z-10 overflow-hidden">
      <div className="absolute inset-0 bg-linear-to-br from-background/96 via-background/92 to-muted/75 backdrop-blur-md" />
      <div className="absolute -left-10 top-6 h-28 w-28 rounded-full bg-cyan-500/12 blur-3xl" />
      <div className="absolute -right-6 bottom-0 h-32 w-32 rounded-full bg-emerald-500/12 blur-3xl" />

      <div className="relative flex h-full items-center justify-center px-4">
        <div className="w-full max-w-xl rounded-[22px] border border-border/60 bg-card/82 p-5 shadow-2xl shadow-black/5 backdrop-blur-xl">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
                {windowLabel}
              </p>
              <h3 className="text-sm font-semibold text-foreground">
                {t("publicAgent.latency.loadingTitle")}
              </h3>
              <p className="max-w-sm text-xs leading-5 text-muted-foreground">
                {t("publicAgent.latency.loadingDescription", { window: windowLabel })}
              </p>
            </div>

            <div className="relative flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-background/80">
              <span className="absolute size-7 rounded-full border-2 border-emerald-500/15 border-t-emerald-500 animate-spin" />
              <span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_18px_rgba(16,185,129,0.65)]" />
            </div>
          </div>

          <div className="mt-5 overflow-hidden rounded-2xl border border-border/40 bg-background/45 p-3">
            <div className="mb-3 flex items-center gap-2">
              <span className="h-2.5 w-14 rounded-full bg-emerald-500/15" />
              <span className="h-2.5 w-12 rounded-full bg-cyan-500/15" />
              <span className="h-2.5 w-10 rounded-full bg-amber-500/15" />
            </div>

            <div className="relative h-28">
              <div className="absolute inset-x-0 top-4 border-t border-dashed border-border/30" />
              <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-border/25" />
              <div className="absolute inset-x-0 bottom-4 border-t border-dashed border-border/30" />

              <svg viewBox="0 0 320 120" className="h-full w-full">
                <defs>
                  <linearGradient id="latency-overlay-line-a" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="rgba(16,185,129,0.15)" />
                    <stop offset="50%" stopColor="rgba(16,185,129,0.9)" />
                    <stop offset="100%" stopColor="rgba(6,182,212,0.2)" />
                  </linearGradient>
                  <linearGradient id="latency-overlay-line-b" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="rgba(6,182,212,0.12)" />
                    <stop offset="45%" stopColor="rgba(6,182,212,0.85)" />
                    <stop offset="100%" stopColor="rgba(245,158,11,0.18)" />
                  </linearGradient>
                </defs>

                <path
                  d="M8 88 C 34 84, 56 40, 82 46 S 134 96, 162 78 S 212 24, 248 42 S 288 92, 312 58"
                  fill="none"
                  stroke="url(#latency-overlay-line-a)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  className="opacity-90"
                />
                <path
                  d="M8 70 C 40 96, 68 88, 96 58 S 154 18, 188 32 S 244 96, 274 84 S 302 44, 312 50"
                  fill="none"
                  stroke="url(#latency-overlay-line-b)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  className="opacity-80"
                />

                <circle cx="82" cy="46" r="4" fill="rgba(16,185,129,0.92)" className="animate-pulse" />
                <circle cx="188" cy="32" r="3.5" fill="rgba(6,182,212,0.92)" className="animate-pulse" />
                <circle cx="274" cy="84" r="3.5" fill="rgba(245,158,11,0.9)" className="animate-pulse" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const LatencyCard = React.memo(function LatencyCard(props: LatencyCardProps) {
  const { t } = useTranslation();
  const [symlog, setSymlog] = React.useState(false);
  const {
    probeLatestLoading,
    probeLatestError,
    allProbeResults,
    latencyProbeResults,
    selectedProbeTaskIds,
    setSelectedProbeTaskIds,
    latencyWindow,
    setLatencyWindow,
    latencyChartData,
    latencyLines,
    latencyXTickFormatter,
    latencyStatsByTaskId,
    latencySeriesLoading,
    firstProbeSeriesError,
  } = props;

  const renderContent = (): React.ReactNode => {
    if (probeLatestError) {
      return (
        <ChartPlaceholder
          status="error"
          message={getUserErrorMessage(probeLatestError, t, { action: "load" })}
        />
      );
    }
    if (probeLatestLoading) return <ChartPlaceholder status="loading" />;
    if (allProbeResults.length === 0) {
      return <ChartPlaceholder status="empty" message={t("publicAgent.latency.noTasks")} />;
    }
    if (latencyProbeResults.length === 0) {
      return <ChartPlaceholder status="empty" message={t("publicAgent.latency.noLatencyTasks")} />;
    }
    if (firstProbeSeriesError) {
      return (
        <ChartPlaceholder
          status="error"
          message={getUserErrorMessage(firstProbeSeriesError, t, { action: "load" })}
        />
      );
    }
    if (selectedProbeTaskIds.length === 0) return <ChartPlaceholder status="empty" />;
    if (latencySeriesLoading) return <LatencyLoadingOverlay window={latencyWindow} />;
    if (latencyChartData.length === 0) return <ChartPlaceholder status="empty" />;
    return (
      <MemoLatencyLineChart
        data={latencyChartData}
        lines={latencyLines}
        xTickFormatter={latencyXTickFormatter}
        symlog={symlog}
      />
    );
  };

  return (
    <div className="hina-latency-card overflow-hidden rounded-2xl border border-border/50 bg-card backdrop-blur-sm">
      <div className="border-b border-border/30 px-3 py-3 sm:px-5 sm:py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="text-muted-foreground">
              <Globe className="size-4" />
            </span>
            <h2 className="text-sm font-semibold uppercase tracking-wider">{t("publicAgent.tabs.latency")}</h2>
          </div>
          <div className="flex items-center gap-2">
            <Toggle size="sm" pressed={symlog} onPressedChange={setSymlog}>
              {t("publicAgent.latency.symlog")}
            </Toggle>
            <TimeRangeSelector value={latencyWindow} onChange={setLatencyWindow} windows={LATENCY_WINDOWS} />
          </div>
        </div>
      </div>

      <div className="relative px-3 py-4" style={{ height: 300 }}>
        {renderContent()}
      </div>

      {/* Stats footer */}
      {latencyProbeResults.length > 0 ? (
        <LatencyStats
          selectedProbeTaskIds={selectedProbeTaskIds}
          setSelectedProbeTaskIds={setSelectedProbeTaskIds}
          latencyProbeResults={latencyProbeResults}
          statsByTaskId={latencyStatsByTaskId}
        />
      ) : null}
    </div>
  );
});
