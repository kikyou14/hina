import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { metricRollup } from "../db/schema";
import { listTelemetryIntervalsSec } from "../rollup/telemetry-policy";
import { chooseIntervalSec, type Resolution } from "../series/resolution";

export type TelemetrySeriesParams = {
  agentId: string;
  fromMs: number;
  toMs: number;
  resolution: Resolution;
  maxPoints: number;
};

type RollupRow = {
  bucketStartMs: number;
  samples: number;
  cpuPct: number | null;
  memUsedPct: number | null;
  diskUsedPct: number | null;
  procCount: number | null;
  connTcp: number | null;
  connUdp: number | null;
  rxBytesSum: number;
  txBytesSum: number;
};

function buildMetricsMap(row: RollupRow): Record<string, number> {
  const m: Record<string, number> = {};
  if (row.cpuPct !== null) m["cpu.usage_pct"] = row.cpuPct;
  if (row.memUsedPct !== null) m["mem.used_pct"] = row.memUsedPct;
  if (row.diskUsedPct !== null) m["disk.used_pct"] = row.diskUsedPct;
  if (row.procCount !== null) m["proc.count"] = row.procCount;
  if (row.connTcp !== null) m["conn.tcp.count"] = row.connTcp;
  if (row.connUdp !== null) m["conn.udp.count"] = row.connUdp;
  return m;
}

export async function queryTelemetrySeries(db: DbClient, params: TelemetrySeriesParams) {
  const { agentId, fromMs, toMs, resolution, maxPoints } = params;
  const nowMs = Date.now();

  const availableIntervalsSec = listTelemetryIntervalsSec(nowMs - fromMs);
  if (availableIntervalsSec.length === 0) {
    return {
      ok: false as const,
      error: { ok: false as const, code: "range_too_large" as const },
    };
  }
  const chosen = chooseIntervalSec({
    resolution,
    fromMs,
    toMs,
    maxPoints,
    rawIntervalSec: Math.min(...availableIntervalsSec),
    availableIntervalsSec,
  });

  if (!chosen.ok) {
    return { ok: false as const, error: chosen };
  }

  const intervalSec = chosen.intervalSec;
  const intervalMs = intervalSec * 1000;
  const bucketFrom = Math.floor(fromMs / intervalMs) * intervalMs;
  const bucketTo = Math.floor((toMs - 1) / intervalMs) * intervalMs;

  const rows = await db
    .select({
      bucketStartMs: metricRollup.bucketStartMs,
      samples: metricRollup.samples,
      cpuPct: metricRollup.cpuPct,
      memUsedPct: metricRollup.memUsedPct,
      diskUsedPct: metricRollup.diskUsedPct,
      procCount: metricRollup.procCount,
      connTcp: metricRollup.connTcp,
      connUdp: metricRollup.connUdp,
      rxBytesSum: metricRollup.rxBytesSum,
      txBytesSum: metricRollup.txBytesSum,
    })
    .from(metricRollup)
    .where(
      and(
        eq(metricRollup.agentId, agentId),
        eq(metricRollup.intervalSec, intervalSec),
        gte(metricRollup.bucketStartMs, bucketFrom),
        lte(metricRollup.bucketStartMs, bucketTo),
      ),
    )
    .orderBy(asc(metricRollup.bucketStartMs));

  return {
    ok: true as const,
    body: {
      ok: true,
      agentId,
      fromMs,
      toMs,
      resolution,
      maxPoints,
      intervalSec,
      points: rows.map((r) => ({
        t: r.bucketStartMs,
        s: r.samples,
        rx: r.rxBytesSum,
        tx: r.txBytesSum,
        m: buildMetricsMap(r),
      })),
    },
  };
}
