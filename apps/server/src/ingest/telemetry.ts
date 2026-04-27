import { eq, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { DbTx } from "../db/client";
import { agentStatus, metricRollup, trafficCounter, trafficDay } from "../db/schema";
import { listTelemetryIntervalsSec } from "../rollup/telemetry-policy";

export type TelemetryIngestArgs = {
  agentId: string;
  recvTsMs: number;
  seq: number;
  uptimeSec: number | null;
  rxBytesTotal: number;
  txBytesTotal: number;
  latestTelemetryPack: Buffer;
  latestInventoryPack?: Buffer;
  numericMetrics: Record<string, unknown>;
};

export type TelemetryIngestResult = {
  numericMetrics: Record<string, number>;
  deltaRx: number;
  deltaTx: number;
};

function toDayYyyyMmDdUtc(tsMs: number): number {
  const d = new Date(tsMs);
  const yyyy = d.getUTCFullYear();
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return yyyy * 10000 + mm * 100 + dd;
}

function safeDelta(current: number, previous: number): number {
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(previous)) return 0;
  if (current < 0 || previous < 0) return 0;
  if (current >= previous) return current - previous;
  return current;
}

function extractNumericMetrics(input: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

type RollupMetricValues = {
  cpuPct: number | null;
  memUsedPct: number | null;
  diskUsedPct: number | null;
  procCount: number | null;
  connTcp: number | null;
  connUdp: number | null;
};

function pickFinite(source: Record<string, number>, key: string): number | null {
  const v = source[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function extractRollupMetrics(numericMetrics: Record<string, number>): RollupMetricValues {
  return {
    cpuPct: pickFinite(numericMetrics, "cpu.usage_pct"),
    memUsedPct: pickFinite(numericMetrics, "mem.used_pct"),
    diskUsedPct: pickFinite(numericMetrics, "disk.used_pct"),
    procCount: pickFinite(numericMetrics, "proc.count"),
    connTcp: pickFinite(numericMetrics, "conn.tcp.count"),
    connUdp: pickFinite(numericMetrics, "conn.udp.count"),
  };
}

function nextRunningAverage(
  col: SQLiteColumn,
  fieldSamples: SQLiteColumn,
  incoming: number | null,
): SQL {
  if (incoming === null) return sql`${col}`;
  return sql`
    case
      when ${col} is null then ${incoming}
      else (${col} * ${fieldSamples} + ${incoming}) / (${fieldSamples} + 1.0)
    end
  `;
}

function nextFieldSamples(fieldSamples: SQLiteColumn, incoming: number | null): SQL {
  if (incoming === null) return sql`${fieldSamples}`;
  return sql`${fieldSamples} + 1`;
}

function initialFieldSamples(incoming: number | null): number {
  return incoming === null ? 0 : 1;
}

async function upsertAgentStatus(tx: DbTx, args: TelemetryIngestArgs, includePacks: boolean) {
  const nowMs = args.recvTsMs;

  const packInsert = includePacks
    ? {
        lastMetricsPack: args.latestTelemetryPack,
        lastInventoryPack: args.latestInventoryPack,
      }
    : {};

  const packUpdate = includePacks
    ? {
        lastMetricsPack: args.latestTelemetryPack,
        ...(args.latestInventoryPack ? { lastInventoryPack: args.latestInventoryPack } : {}),
      }
    : {};

  await tx
    .insert(agentStatus)
    .values({
      agentId: args.agentId,
      online: true,
      lastSeenAtMs: nowMs,
      lastSeq: args.seq,
      ...packInsert,
      updatedAtMs: nowMs,
    })
    .onConflictDoUpdate({
      target: agentStatus.agentId,
      set: {
        online: true,
        lastSeenAtMs: nowMs,
        lastSeq: args.seq,
        ...packUpdate,
        updatedAtMs: nowMs,
      },
    });
}

async function applyTrafficDelta(
  tx: DbTx,
  args: TelemetryIngestArgs,
): Promise<{ deltaRx: number; deltaTx: number }> {
  const nowMs = args.recvTsMs;
  if (!Number.isSafeInteger(args.rxBytesTotal) || !Number.isSafeInteger(args.txBytesTotal)) {
    return { deltaRx: 0, deltaTx: 0 };
  }

  const existing = await tx
    .select({
      lastRx: trafficCounter.lastRxBytesTotal,
      lastTx: trafficCounter.lastTxBytesTotal,
    })
    .from(trafficCounter)
    .where(eq(trafficCounter.agentId, args.agentId))
    .limit(1);

  if (existing.length === 0) {
    await tx.insert(trafficCounter).values({
      agentId: args.agentId,
      lastTsMs: nowMs,
      lastRxBytesTotal: args.rxBytesTotal,
      lastTxBytesTotal: args.txBytesTotal,
      updatedAtMs: nowMs,
    });
    return { deltaRx: 0, deltaTx: 0 };
  }

  const prev = existing[0]!;
  const deltaRx = safeDelta(args.rxBytesTotal, prev.lastRx);
  const deltaTx = safeDelta(args.txBytesTotal, prev.lastTx);

  await tx
    .update(trafficCounter)
    .set({
      lastTsMs: nowMs,
      lastRxBytesTotal: args.rxBytesTotal,
      lastTxBytesTotal: args.txBytesTotal,
      updatedAtMs: nowMs,
    })
    .where(eq(trafficCounter.agentId, args.agentId));

  const day = toDayYyyyMmDdUtc(nowMs);
  await tx
    .insert(trafficDay)
    .values({
      agentId: args.agentId,
      dayYyyyMmDd: day,
      rxBytes: deltaRx,
      txBytes: deltaTx,
      updatedAtMs: nowMs,
    })
    .onConflictDoUpdate({
      target: [trafficDay.agentId, trafficDay.dayYyyyMmDd],
      set: {
        rxBytes: sql`${trafficDay.rxBytes} + ${deltaRx}`,
        txBytes: sql`${trafficDay.txBytes} + ${deltaTx}`,
        updatedAtMs: nowMs,
      },
    });

  return { deltaRx, deltaTx };
}

async function upsertRollupBucket(
  tx: DbTx,
  args: TelemetryIngestArgs,
  intervalSec: number,
  rollupMetrics: RollupMetricValues,
  deltaRx: number,
  deltaTx: number,
) {
  const bucketStartMs = Math.floor(args.recvTsMs / (intervalSec * 1000)) * intervalSec * 1000;

  await tx
    .insert(metricRollup)
    .values({
      agentId: args.agentId,
      intervalSec,
      bucketStartMs,
      samples: 1,
      cpuPct: rollupMetrics.cpuPct,
      cpuSamples: initialFieldSamples(rollupMetrics.cpuPct),
      memUsedPct: rollupMetrics.memUsedPct,
      memUsedSamples: initialFieldSamples(rollupMetrics.memUsedPct),
      diskUsedPct: rollupMetrics.diskUsedPct,
      diskUsedSamples: initialFieldSamples(rollupMetrics.diskUsedPct),
      procCount: rollupMetrics.procCount,
      procCountSamples: initialFieldSamples(rollupMetrics.procCount),
      connTcp: rollupMetrics.connTcp,
      connTcpSamples: initialFieldSamples(rollupMetrics.connTcp),
      connUdp: rollupMetrics.connUdp,
      connUdpSamples: initialFieldSamples(rollupMetrics.connUdp),
      rxBytesSum: deltaRx,
      txBytesSum: deltaTx,
      createdAtMs: args.recvTsMs,
    })
    .onConflictDoUpdate({
      target: [metricRollup.agentId, metricRollup.intervalSec, metricRollup.bucketStartMs],
      set: {
        samples: sql`${metricRollup.samples} + 1`,
        cpuPct: nextRunningAverage(
          metricRollup.cpuPct,
          metricRollup.cpuSamples,
          rollupMetrics.cpuPct,
        ),
        cpuSamples: nextFieldSamples(metricRollup.cpuSamples, rollupMetrics.cpuPct),
        memUsedPct: nextRunningAverage(
          metricRollup.memUsedPct,
          metricRollup.memUsedSamples,
          rollupMetrics.memUsedPct,
        ),
        memUsedSamples: nextFieldSamples(metricRollup.memUsedSamples, rollupMetrics.memUsedPct),
        diskUsedPct: nextRunningAverage(
          metricRollup.diskUsedPct,
          metricRollup.diskUsedSamples,
          rollupMetrics.diskUsedPct,
        ),
        diskUsedSamples: nextFieldSamples(metricRollup.diskUsedSamples, rollupMetrics.diskUsedPct),
        procCount: nextRunningAverage(
          metricRollup.procCount,
          metricRollup.procCountSamples,
          rollupMetrics.procCount,
        ),
        procCountSamples: nextFieldSamples(metricRollup.procCountSamples, rollupMetrics.procCount),
        connTcp: nextRunningAverage(
          metricRollup.connTcp,
          metricRollup.connTcpSamples,
          rollupMetrics.connTcp,
        ),
        connTcpSamples: nextFieldSamples(metricRollup.connTcpSamples, rollupMetrics.connTcp),
        connUdp: nextRunningAverage(
          metricRollup.connUdp,
          metricRollup.connUdpSamples,
          rollupMetrics.connUdp,
        ),
        connUdpSamples: nextFieldSamples(metricRollup.connUdpSamples, rollupMetrics.connUdp),
        rxBytesSum: sql`${metricRollup.rxBytesSum} + ${deltaRx}`,
        txBytesSum: sql`${metricRollup.txBytesSum} + ${deltaTx}`,
      },
    });
}

export async function ingestTelemetryTrafficAndRollup(
  tx: DbTx,
  args: TelemetryIngestArgs,
): Promise<TelemetryIngestResult> {
  const numericMetrics = extractNumericMetrics(args.numericMetrics);
  const rollupMetrics = extractRollupMetrics(numericMetrics);

  const { deltaRx, deltaTx } = await applyTrafficDelta(tx, args);

  for (const intervalSec of listTelemetryIntervalsSec()) {
    await upsertRollupBucket(tx, args, intervalSec, rollupMetrics, deltaRx, deltaTx);
  }

  return {
    numericMetrics,
    deltaRx,
    deltaTx,
  };
}

export async function upsertAgentStatusFromTelemetry(
  tx: DbTx,
  args: TelemetryIngestArgs,
  includePacks = true,
): Promise<void> {
  await upsertAgentStatus(tx, args, includePacks);
}
