import { sql } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { startIntervalTask } from "../util/interval-task";
import { telemetryTierPolicies, type TelemetryTierPolicy } from "./telemetry-policy";

const MAX_DELETE_CHUNKS_PER_TICK = 16;
const ROLLUP_INTERVAL_MS = 5 * 60 * 1000;

function floorToIntervalMs(tsMs: number, intervalSec: number): number {
  const intervalMs = intervalSec * 1000;
  return tsMs - (tsMs % intervalMs);
}

async function findOldestBucketStartMs(
  db: DbClient,
  intervalSec: number,
  deletionBoundaryMs: number,
): Promise<number | null> {
  const rows = await db.all<{ minBucketStartMs: number | null }>(
    sql`
      select min(bucket_start_ms) as minBucketStartMs
      from metric_rollup
      where interval_sec = ${intervalSec}
        and bucket_start_ms < ${deletionBoundaryMs}
    `,
  );
  return rows[0]?.minBucketStartMs ?? null;
}

async function deleteExpiredChunk(
  db: DbClient,
  tier: TelemetryTierPolicy,
  deletionBoundaryMs: number,
): Promise<boolean> {
  const minBucketStartMs = await findOldestBucketStartMs(db, tier.intervalSec, deletionBoundaryMs);
  if (minBucketStartMs === null) return false;

  const chunkStartMs = floorToIntervalMs(minBucketStartMs, tier.intervalSec);
  const chunkEndMs = Math.min(chunkStartMs + tier.deleteChunkMs, deletionBoundaryMs);
  if (!(chunkEndMs > chunkStartMs)) return false;

  await db.run(sql`
    delete from metric_rollup
    where interval_sec = ${tier.intervalSec}
      and bucket_start_ms >= ${chunkStartMs}
      and bucket_start_ms < ${chunkEndMs}
  `);
  return true;
}

export function startTelemetryRollupWorker(deps: { db: DbClient }) {
  return startIntervalTask({
    label: "telemetry rollup",
    intervalMs: ROLLUP_INTERVAL_MS,
    tick: async () => {
      const nowMs = Date.now();
      let deletedAny = false;
      let chunks = 0;

      for (const tier of telemetryTierPolicies) {
        const deletionBoundaryMs = floorToIntervalMs(nowMs - tier.retentionMs, tier.intervalSec);

        while (chunks < MAX_DELETE_CHUNKS_PER_TICK) {
          const progressed = await deleteExpiredChunk(deps.db, tier, deletionBoundaryMs);
          if (!progressed) break;
          deletedAny = true;
          chunks += 1;
        }

        if (chunks >= MAX_DELETE_CHUNKS_PER_TICK) break;
      }

      if (deletedAny) {
        await deps.db.run(sql`PRAGMA incremental_vacuum`);
      }
    },
  });
}
