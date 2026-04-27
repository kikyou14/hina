import { sql } from "drizzle-orm";
import type { DbClient, DbTx } from "../db/client";
import { startIntervalTask } from "../util/interval-task";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const RAW_RETENTION_DAYS = 7;
const HOURLY_RETENTION_DAYS = 90;
const DAILY_RETENTION_DAYS = 180;

const RAW_TO_HOURLY_BACKFILL_CHUNK_HOURS = 24;
const HOURLY_TO_DAILY_BACKFILL_CHUNK_DAYS = 7;
const MAX_BACKFILL_CHUNKS_PER_TICK = 16;

const ROLLUP_INTERVAL_MS = 5 * 60 * 1000;

function floorToHourMs(tsMs: number): number {
  return tsMs - (tsMs % HOUR_MS);
}

function floorToDayMs(tsMs: number): number {
  return tsMs - (tsMs % DAY_MS);
}

function clampNonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function changesOf(result: unknown): number {
  if (typeof result === "object" && result !== null && "changes" in result) {
    const v = (result as Record<string, unknown>).changes;
    return typeof v === "number" ? v : 0;
  }
  return 0;
}

async function listKnownTaskIds(db: DbClient): Promise<string[]> {
  const rows = await db.all<{ taskId: string }>(
    sql`select distinct prl.task_id as taskId
        from probe_result_latest prl
        inner join probe_task pt on pt.id = prl.task_id
        where pt.kind != 'traceroute'`,
  );
  return rows.map((r) => r.taskId).filter((s) => typeof s === "string" && s.length > 0);
}

type SqlRunner = Pick<DbClient, "run"> | Pick<DbTx, "run">;

async function upsertHourlyForTask(
  db: SqlRunner,
  taskId: string,
  fromMs: number,
  toMs: number,
): Promise<void> {
  if (!(toMs > fromMs)) return;

  await db.run(sql`
    insert into probe_result_hourly (
      agent_id,
      task_id,
      bucket_start_ms,
      samples,
      ok_samples,
      lat_samples,
      lat_sum_ms,
      lat_min_ms,
      lat_max_ms,
      loss_samples,
      loss_sum_pct,
      loss_max_pct,
      jit_samples,
      jit_sum_ms,
      jit_max_ms,
      created_at_ms
    )
    select
      agent_id,
      task_id,
      (ts_ms - (ts_ms % ${HOUR_MS})) as bucket_start_ms,
      count(1) as samples,
      sum(case when ok = 1 then 1 else 0 end) as ok_samples,
      count(lat_ms) as lat_samples,
      coalesce(sum(lat_ms), 0) as lat_sum_ms,
      min(lat_ms) as lat_min_ms,
      max(lat_ms) as lat_max_ms,
      count(loss_pct) as loss_samples,
      coalesce(sum(loss_pct), 0) as loss_sum_pct,
      max(loss_pct) as loss_max_pct,
      count(jitter_ms) as jit_samples,
      coalesce(sum(jitter_ms), 0) as jit_sum_ms,
      max(jitter_ms) as jit_max_ms,
      max(created_at_ms) as created_at_ms
    from probe_result
    where task_id = ${taskId} and ts_ms >= ${fromMs} and ts_ms < ${toMs}
    group by agent_id, task_id, bucket_start_ms
    on conflict(agent_id, task_id, bucket_start_ms) do update set
      samples = excluded.samples,
      ok_samples = excluded.ok_samples,
      lat_samples = excluded.lat_samples,
      lat_sum_ms = excluded.lat_sum_ms,
      lat_min_ms = excluded.lat_min_ms,
      lat_max_ms = excluded.lat_max_ms,
      loss_samples = excluded.loss_samples,
      loss_sum_pct = excluded.loss_sum_pct,
      loss_max_pct = excluded.loss_max_pct,
      jit_samples = excluded.jit_samples,
      jit_sum_ms = excluded.jit_sum_ms,
      jit_max_ms = excluded.jit_max_ms,
      created_at_ms = excluded.created_at_ms
  `);
}

async function backfillAndDeleteOldRawForTask(
  db: DbClient,
  taskId: string,
  rawDeletionBoundaryMs: number,
): Promise<boolean> {
  const rows = await db.all<{ minTsMs: number | null }>(
    sql`select min(ts_ms) as minTsMs from probe_result where task_id = ${taskId} and ts_ms < ${rawDeletionBoundaryMs}`,
  );
  const minTsMs = rows[0]?.minTsMs ?? null;
  if (minTsMs === null) return false;

  const chunkStartMs = floorToHourMs(clampNonNegativeInt(minTsMs));
  const chunkEndMs = Math.min(
    chunkStartMs + RAW_TO_HOURLY_BACKFILL_CHUNK_HOURS * HOUR_MS,
    rawDeletionBoundaryMs,
  );
  if (!(chunkEndMs > chunkStartMs)) return false;

  await db.transaction(async (tx) => {
    await upsertHourlyForTask(tx, taskId, chunkStartMs, chunkEndMs);
    await tx.run(
      sql`delete from probe_result where task_id = ${taskId} and ts_ms >= ${chunkStartMs} and ts_ms < ${chunkEndMs}`,
    );
  });

  return true;
}

async function upsertDailyForTask(
  db: SqlRunner,
  taskId: string,
  fromMs: number,
  toMs: number,
): Promise<void> {
  if (!(toMs > fromMs)) return;

  await db.run(sql`
    insert into probe_result_daily (
      agent_id,
      task_id,
      bucket_start_ms,
      samples,
      ok_samples,
      lat_samples,
      lat_sum_ms,
      lat_min_ms,
      lat_max_ms,
      loss_samples,
      loss_sum_pct,
      loss_max_pct,
      jit_samples,
      jit_sum_ms,
      jit_max_ms,
      created_at_ms
    )
    select
      agent_id,
      task_id,
      (bucket_start_ms - (bucket_start_ms % ${DAY_MS})) as bucket_start_ms,
      sum(samples) as samples,
      sum(ok_samples) as ok_samples,
      sum(lat_samples) as lat_samples,
      sum(lat_sum_ms) as lat_sum_ms,
      min(lat_min_ms) as lat_min_ms,
      max(lat_max_ms) as lat_max_ms,
      sum(loss_samples) as loss_samples,
      sum(loss_sum_pct) as loss_sum_pct,
      max(loss_max_pct) as loss_max_pct,
      sum(jit_samples) as jit_samples,
      sum(jit_sum_ms) as jit_sum_ms,
      max(jit_max_ms) as jit_max_ms,
      max(created_at_ms) as created_at_ms
    from probe_result_hourly
    where task_id = ${taskId} and bucket_start_ms >= ${fromMs} and bucket_start_ms < ${toMs}
    group by agent_id, task_id, (bucket_start_ms - (bucket_start_ms % ${DAY_MS}))
    on conflict(agent_id, task_id, bucket_start_ms) do update set
      samples = excluded.samples,
      ok_samples = excluded.ok_samples,
      lat_samples = excluded.lat_samples,
      lat_sum_ms = excluded.lat_sum_ms,
      lat_min_ms = excluded.lat_min_ms,
      lat_max_ms = excluded.lat_max_ms,
      loss_samples = excluded.loss_samples,
      loss_sum_pct = excluded.loss_sum_pct,
      loss_max_pct = excluded.loss_max_pct,
      jit_samples = excluded.jit_samples,
      jit_sum_ms = excluded.jit_sum_ms,
      jit_max_ms = excluded.jit_max_ms,
      created_at_ms = excluded.created_at_ms
  `);
}

async function backfillAndDeleteOldHourlyForTask(
  db: DbClient,
  taskId: string,
  hourlyDeletionBoundaryMs: number,
): Promise<boolean> {
  const rows = await db.all<{ minBucketStartMs: number | null }>(
    sql`select min(bucket_start_ms) as minBucketStartMs from probe_result_hourly where task_id = ${taskId} and bucket_start_ms < ${hourlyDeletionBoundaryMs}`,
  );
  const minBucketStartMs = rows[0]?.minBucketStartMs ?? null;
  if (minBucketStartMs === null) return false;

  const chunkStartMs = floorToDayMs(clampNonNegativeInt(minBucketStartMs));
  const chunkEndMs = Math.min(
    chunkStartMs + HOURLY_TO_DAILY_BACKFILL_CHUNK_DAYS * DAY_MS,
    hourlyDeletionBoundaryMs,
  );
  if (!(chunkEndMs > chunkStartMs)) return false;

  await db.transaction(async (tx) => {
    await upsertDailyForTask(tx, taskId, chunkStartMs, chunkEndMs);
    await tx.run(
      sql`delete from probe_result_hourly where task_id = ${taskId} and bucket_start_ms >= ${chunkStartMs} and bucket_start_ms < ${chunkEndMs}`,
    );
  });

  return true;
}

async function deleteOldDaily(db: DbClient, dailyDeletionBoundaryMs: number): Promise<number> {
  const res = await db.run(
    sql`delete from probe_result_daily where bucket_start_ms < ${dailyDeletionBoundaryMs}`,
  );
  return changesOf(res);
}

export function startProbeRollupWorker(deps: { db: DbClient }) {
  return startIntervalTask({
    label: "probe rollup",
    intervalMs: ROLLUP_INTERVAL_MS,
    tick: async () => {
      const nowMs = Date.now();

      const currentHourStartMs = floorToHourMs(nowMs);
      const currentDayStartMs = floorToDayMs(nowMs);

      const rawDeletionBoundaryMs = floorToHourMs(nowMs - RAW_RETENTION_DAYS * DAY_MS);
      const hourlyDeletionBoundaryMs = floorToDayMs(nowMs - HOURLY_RETENTION_DAYS * DAY_MS);
      const dailyDeletionBoundaryMs = floorToDayMs(nowMs - DAILY_RETENTION_DAYS * DAY_MS);

      const taskIds = await listKnownTaskIds(deps.db);

      for (const taskId of taskIds) {
        const fromMs = currentHourStartMs - 2 * HOUR_MS;
        await upsertHourlyForTask(deps.db, taskId, fromMs, currentHourStartMs);
      }

      for (const taskId of taskIds) {
        const fromMs = currentDayStartMs - 2 * DAY_MS;
        await upsertDailyForTask(deps.db, taskId, fromMs, currentDayStartMs);
      }

      let didDelete = false;
      let chunks = 0;

      for (const taskId of taskIds) {
        while (chunks < MAX_BACKFILL_CHUNKS_PER_TICK) {
          const progressed = await backfillAndDeleteOldRawForTask(
            deps.db,
            taskId,
            rawDeletionBoundaryMs,
          );
          if (!progressed) break;
          didDelete = true;
          chunks += 1;
        }
        if (chunks >= MAX_BACKFILL_CHUNKS_PER_TICK) break;
      }

      for (const taskId of taskIds) {
        while (chunks < MAX_BACKFILL_CHUNKS_PER_TICK) {
          const progressed = await backfillAndDeleteOldHourlyForTask(
            deps.db,
            taskId,
            hourlyDeletionBoundaryMs,
          );
          if (!progressed) break;
          didDelete = true;
          chunks += 1;
        }
        if (chunks >= MAX_BACKFILL_CHUNKS_PER_TICK) break;
      }

      const dailyDeleted = await deleteOldDaily(deps.db, dailyDeletionBoundaryMs);
      if (dailyDeleted > 0) didDelete = true;

      if (didDelete) {
        await deps.db.run(sql`PRAGMA incremental_vacuum`);
      }
    },
  });
}
