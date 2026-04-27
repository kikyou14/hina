import * as React from "react";

import type { TimeSeriesPoint } from "@/components/charts/TimeSeriesLineChart";
import { usePublicLiveSync } from "@/live/public";
import { usePublicAgentSeries } from "@/queries/public";

import {
  type TrafficRate,
  LIVE_BUFFER_MAX_MS,
  LIVE_BUFFER_FLUSH_INTERVAL_MS,
  clampFinite,
  metricsToChartPoint,
  rollupPointToChartPoint,
} from "../lib/chartHelpers";
import { getMetricWindowRangeMs } from "../lib/timeWindows";

export type LiveSeedStatus = "loading" | "error" | "ready";

export function useLiveMetricBuffer(agentId: string) {
  const liveBufferRef = React.useRef<TimeSeriesPoint[]>([]);
  const [liveBuffer, setLiveBuffer] = React.useState<TimeSeriesPoint[]>([]);
  const liveBufferFlushRef = React.useRef(0);
  const liveBufferFlushTimerRef = React.useRef<number | null>(null);
  const trafficRateRef = React.useRef<TrafficRate | null>(null);
  const lastDeltaTsRef = React.useRef<number | null>(null);

  const cancelLiveBufferFlush = React.useEffectEvent(() => {
    if (liveBufferFlushTimerRef.current === null) return;
    window.clearTimeout(liveBufferFlushTimerRef.current);
    liveBufferFlushTimerRef.current = null;
  });

  const flushLiveBuffer = React.useEffectEvent(() => {
    cancelLiveBufferFlush();
    liveBufferFlushRef.current = Date.now();
    setLiveBuffer(liveBufferRef.current);
  });

  const liveRangeMs = getMetricWindowRangeMs("live");
  const [liveRangeEndMs, setLiveRangeEndMs] = React.useState(() => Date.now());
  const liveSeries = usePublicAgentSeries({
    agentId,
    fromMs: liveRangeEndMs - liveRangeMs,
    toMs: liveRangeEndMs,
    resolution: "auto",
    maxPoints: 2000,
  });

  React.useEffect(() => {
    if (!liveSeries.data || liveSeries.data.ok !== true) return;
    if (liveBufferRef.current.length > 0) return;
    const { points, intervalSec } = liveSeries.data;
    const seeded = points.map((p) => rollupPointToChartPoint(p, intervalSec));
    liveBufferRef.current = seeded;
    setLiveBuffer(seeded);
  }, [liveSeries.data]);

  React.useEffect(() => {
    setLiveRangeEndMs(Date.now());
    cancelLiveBufferFlush();
    liveBufferRef.current = [];
    setLiveBuffer([]);
    liveBufferFlushRef.current = 0;
    trafficRateRef.current = null;
    lastDeltaTsRef.current = null;
  }, [agentId]);

  const prevLiveStatusRef = React.useRef<string | null>(null);
  const { status: liveStatus } = usePublicLiveSync({
    agentId,
    liveSeries: false,
    onTelemetryDelta: (message) => {
      let rxRate = clampFinite(message.metrics["net.rx_rate"]);
      let txRate = clampFinite(message.metrics["net.tx_rate"]);
      if (rxRate === null || txRate === null) {
        const prevTs = lastDeltaTsRef.current;
        if (prevTs !== null) {
          const elapsed = (message.tsMs - prevTs) / 1000;
          if (Number.isFinite(elapsed) && elapsed > 0) {
            rxRate ??= message.deltaRx / elapsed;
            txRate ??= message.deltaTx / elapsed;
          }
        }
      }
      lastDeltaTsRef.current = message.tsMs;
      if (rxRate !== null || txRate !== null) {
        trafficRateRef.current = { rxRate, txRate, updatedAtMs: message.tsMs };
      }
      const enrichedMetrics =
        rxRate !== null || txRate !== null
          ? { ...message.metrics, "net.rx_rate": rxRate ?? 0, "net.tx_rate": txRate ?? 0 }
          : message.metrics;
      const point = metricsToChartPoint(message.tsMs, enrichedMetrics);
      const prev = liveBufferRef.current;
      const cutoff = message.tsMs - LIVE_BUFFER_MAX_MS;
      let start = 0;
      while (start < prev.length && prev[start]!.t < cutoff) start++;
      const next = start === 0 ? [...prev, point] : [...prev.slice(start), point];
      liveBufferRef.current = next;
      const now = Date.now();
      const elapsed = now - liveBufferFlushRef.current;
      if (elapsed >= LIVE_BUFFER_FLUSH_INTERVAL_MS) {
        flushLiveBuffer();
        return;
      }
      if (liveBufferFlushTimerRef.current !== null) return;
      liveBufferFlushTimerRef.current = window.setTimeout(() => {
        liveBufferFlushTimerRef.current = null;
        flushLiveBuffer();
      }, LIVE_BUFFER_FLUSH_INTERVAL_MS - elapsed);
    },
  });

  React.useEffect(() => {
    const prev = prevLiveStatusRef.current;
    prevLiveStatusRef.current = liveStatus;
    if (prev !== "reconnecting" || liveStatus !== "connected") return;

    setLiveRangeEndMs(Date.now());
    cancelLiveBufferFlush();
    liveBufferRef.current = [];
    setLiveBuffer([]);
    liveBufferFlushRef.current = 0;
    trafficRateRef.current = null;
    lastDeltaTsRef.current = null;
  }, [liveStatus]);

  React.useEffect(() => {
    return () => {
      cancelLiveBufferFlush();
    };
  }, []);

  const fallbackRate = React.useMemo((): { rxRate: number | null; txRate: number | null } => {
    if (!liveSeries.data || liveSeries.data.ok !== true) return { rxRate: null, txRate: null };
    const last = liveSeries.data.points.at(-1);
    if (!last) return { rxRate: null, txRate: null };
    const sec = liveSeries.data.intervalSec;
    return {
      rxRate: clampFinite(last.m["net.rx_rate"]) ?? (sec > 0 ? clampFinite(last.rx / sec) : null),
      txRate: clampFinite(last.m["net.tx_rate"]) ?? (sec > 0 ? clampFinite(last.tx / sec) : null),
    };
  }, [liveSeries.data]);

  const getDisplayedRate = React.useCallback(
    (nowMs: number): TrafficRate => {
      const staleMs = 3 * 60 * 1000;
      const rate = trafficRateRef.current;
      if (rate && nowMs - rate.updatedAtMs <= staleMs) return rate;
      return { rxRate: fallbackRate.rxRate, txRate: fallbackRate.txRate, updatedAtMs: nowMs };
    },
    [fallbackRate],
  );

  const liveSeedStatus: LiveSeedStatus = liveSeries.error
    ? "error"
    : !liveSeries.data
      ? "loading"
      : liveSeries.data.ok
        ? "ready"
        : "error";

  return { liveBuffer, liveSeedStatus, getDisplayedRate, liveStatus } as const;
}
