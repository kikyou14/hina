import * as React from "react";
import { useQueries } from "@tanstack/react-query";

import { getPublicProbeResultsSeries } from "@/api/public";
import { useSiteConfig } from "@/components/SiteConfigProvider";
import { usePublicAgentProbeLatest } from "@/queries/public";
import { parseTracerouteExtraV1 } from "@/lib/traceroute";

import {
  buildLatencyChartSeries,
  buildLatencyStats,
  type ProbeTaskStats,
  PROBE_LINE_COLORS,
  resolveLatencyQueryPolicy,
} from "../lib/latencyChart";
import {
  getLatencyTimeAxisFormatter,
  getLatencyWindowRangeMs,
  type LatencyWindow,
} from "../lib/timeWindows";

function useStableQueryDataMap<V>(
  keys: readonly string[],
  values: readonly (V | undefined)[],
): Map<string, V> {
  const ref = React.useRef(new Map<string, V>());

  let changed = false;
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i]!;
    const v = values[i];
    if (v === undefined) {
      if (ref.current.has(k)) { changed = true; break; }
    } else if (v !== ref.current.get(k)) {
      changed = true;
      break;
    }
  }
  // Also detect removals: a key previously in the map is no longer in keys.
  if (!changed && ref.current.size > 0) {
    let definedCount = 0;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] !== undefined) definedCount += 1;
    }
    if (definedCount !== ref.current.size) changed = true;
  }

  if (changed) {
    const map = new Map<string, V>();
    for (let i = 0; i < keys.length; i += 1) {
      const v = values[i];
      if (v !== undefined) map.set(keys[i]!, v);
    }
    ref.current = map;
  }

  return ref.current;
}

export function useProbeData(agentId: string) {
  const { timezone } = useSiteConfig();
  const [latencyRange, setLatencyRange] = React.useState(() => ({
    window: "1h" as LatencyWindow,
    endMs: Date.now(),
  }));
  const latencyWindow = latencyRange.window;
  const setLatencyWindow = React.useCallback<React.Dispatch<React.SetStateAction<LatencyWindow>>>(
    (nextWindow) => {
      setLatencyRange((current) => {
        const resolvedWindow =
          typeof nextWindow === "function" ? nextWindow(current.window) : nextWindow;
        if (resolvedWindow === current.window) return current;
        return { window: resolvedWindow, endMs: Date.now() };
      });
    },
    [],
  );
  const latencyRangeMs = getLatencyWindowRangeMs(latencyWindow);
  const latencyFromMs = latencyRange.endMs - latencyRangeMs;
  const latencyToMs = latencyRange.endMs;
  const latencyXTickFormatter = React.useMemo(
    () => getLatencyTimeAxisFormatter(latencyWindow, timezone),
    [latencyWindow, timezone],
  );

  const probeLatest = usePublicAgentProbeLatest(agentId);
  const allProbeResults = probeLatest.data?.results ?? [];

  const latencyProbeResults = React.useMemo(
    () => allProbeResults.filter((result) => result.task.kind !== "traceroute"),
    [allProbeResults],
  );
  const traceProbeResults = React.useMemo(
    () => allProbeResults.filter((result) => result.task.kind === "traceroute"),
    [allProbeResults],
  );
  const latencyProbeTaskIntervalById = React.useMemo(
    () => new Map(latencyProbeResults.map((result) => [result.task.id, result.task.intervalSec])),
    [latencyProbeResults],
  );
  const probeRecordByTaskId = React.useMemo(
    () => new Map(allProbeResults.map((r) => [r.task.id, r])),
    [allProbeResults],
  );

  const [selectedProbeTaskIds, setSelectedProbeTaskIds] = React.useState<string[]>([]);
  const [selectedTraceTaskId, setSelectedTraceTaskId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (selectedProbeTaskIds.length > 0) return;
    if (latencyProbeResults.length === 0) return;
    setSelectedProbeTaskIds(latencyProbeResults.map((r) => r.task.id));
  }, [latencyProbeResults, selectedProbeTaskIds.length]);

  React.useEffect(() => {
    if (selectedProbeTaskIds.length === 0) return;
    const valid = new Set(latencyProbeResults.map((r) => r.task.id));
    const next = selectedProbeTaskIds.filter((id) => valid.has(id));
    if (next.length !== selectedProbeTaskIds.length) setSelectedProbeTaskIds(next);
  }, [latencyProbeResults, selectedProbeTaskIds]);

  React.useEffect(() => {
    if (traceProbeResults.length === 0) {
      if (selectedTraceTaskId !== null) setSelectedTraceTaskId(null);
      return;
    }
    const valid = new Set(traceProbeResults.map((result) => result.task.id));
    if (!selectedTraceTaskId || !valid.has(selectedTraceTaskId)) {
      setSelectedTraceTaskId(traceProbeResults[0]!.task.id);
    }
  }, [selectedTraceTaskId, traceProbeResults]);

  const activeTraceTaskId = selectedTraceTaskId ?? traceProbeResults[0]?.task.id ?? null;
  const traceRecord = React.useMemo(
    () => (activeTraceTaskId ? probeRecordByTaskId.get(activeTraceTaskId) ?? null : null),
    [activeTraceTaskId, probeRecordByTaskId],
  );
  const traceLatest = traceRecord?.latest ?? null;
  const traceExtra = React.useMemo(() => parseTracerouteExtraV1(traceLatest?.extra), [traceLatest?.extra]);
  const canRenderTrace =
    traceRecord?.task.kind === "traceroute" && traceLatest !== null && traceLatest.extraParseError !== true && traceExtra !== null;
  const rawTraceText = traceLatest
    ? traceLatest.extraParseError
      ? traceLatest.extraRawJson ?? ""
      : JSON.stringify(traceLatest.extra, null, 2)
    : "";

  React.useEffect(() => {
    setLatencyRange((current) => ({ ...current, endMs: Date.now() }));
  }, [agentId]);

  const probeSeriesQueries = useQueries({
    queries: selectedProbeTaskIds.map((taskId) => {
      const policy = resolveLatencyQueryPolicy(
        latencyWindow,
        latencyProbeTaskIntervalById.get(taskId),
      );
      const queryArgs = {
        agentId,
        taskId,
        fromMs: latencyFromMs,
        toMs: latencyToMs,
        tier: policy.tier,
        maxPoints: policy.maxPoints,
      };

      return {
        queryKey: ["public", "probeResultsSeries", queryArgs],
        queryFn: () => getPublicProbeResultsSeries(queryArgs),
        enabled: agentId.length > 0 && taskId.length > 0 && latencyToMs > latencyFromMs,
        staleTime: 15_000,
      };
    }),
  });

  const probeSeriesByTaskId = useStableQueryDataMap(
    selectedProbeTaskIds,
    probeSeriesQueries.map((q) => q.data),
  );

  const latencySeriesByTaskId = React.useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildLatencyChartSeries>>();
    for (const taskId of selectedProbeTaskIds) {
      map.set(taskId, buildLatencyChartSeries(probeSeriesByTaskId.get(taskId)));
    }
    return map;
  }, [probeSeriesByTaskId, selectedProbeTaskIds]);

  const latencyChartData = React.useMemo(() => {
    const timestamps = new Set<number>();
    for (const taskId of selectedProbeTaskIds) {
      const points = latencySeriesByTaskId.get(taskId) ?? [];
      for (const point of points) timestamps.add(point.t);
    }
    return [...timestamps]
      .sort((a, b) => a - b)
      .map((t) => ({ t }));
  }, [latencySeriesByTaskId, selectedProbeTaskIds]);

  const firstProbeSeriesError = React.useMemo(() => {
    for (const q of probeSeriesQueries) {
      if (q.isError) return q.error;
    }
    return null;
    // probeSeriesQueries ref changes every render; status changes are
    // correctly captured because React Query triggers a re-render when a
    // query transitions to error state, at which point this memo re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeSeriesQueries.map((q) => q.status).join()]);

  const latencySeriesLoading = React.useMemo(() => {
    if (selectedProbeTaskIds.length === 0) return false;
    for (const query of probeSeriesQueries) {
      if (query.isError) return false;
      if (query.data === undefined) return true;
    }
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeSeriesQueries.map((q) => q.status).join(), selectedProbeTaskIds.length]);

  const latencyLines = React.useMemo(() => {
    return selectedProbeTaskIds.map((taskId) => {
      const record = probeRecordByTaskId.get(taskId) ?? null;
      const colorIdx = latencyProbeResults.findIndex((r) => r.task.id === taskId);
      return {
        key: taskId,
        name: record?.task.name ?? taskId.slice(0, 8),
        stroke: PROBE_LINE_COLORS[Math.max(0, colorIdx) % PROBE_LINE_COLORS.length]!,
        data: latencySeriesByTaskId.get(taskId) ?? [],
      };
    });
  }, [probeRecordByTaskId, selectedProbeTaskIds, latencySeriesByTaskId, latencyProbeResults]);

  const latencyStatsByTaskId = React.useMemo(() => {
    const map = new Map<string, ProbeTaskStats>();
    for (const taskId of selectedProbeTaskIds) {
      map.set(taskId, buildLatencyStats(probeSeriesByTaskId.get(taskId)));
    }
    return map;
  }, [probeSeriesByTaskId, selectedProbeTaskIds]);

  return {
    probeLatestLoading: probeLatest.isLoading,
    probeLatestError: probeLatest.isError ? probeLatest.error : null,
    allProbeResults,
    latencyProbeResults,
    traceProbeResults,
    selectedProbeTaskIds,
    setSelectedProbeTaskIds,
    selectedTraceTaskId: activeTraceTaskId,
    setSelectedTraceTaskId,
    latencyWindow,
    setLatencyWindow,
    latencyChartData,
    latencyLines,
    latencyXTickFormatter,
    latencyStatsByTaskId,
    latencySeriesLoading,
    firstProbeSeriesError,
    traceLatest,
    traceExtra,
    canRenderTrace,
    rawTraceText,
  } as const;
}
