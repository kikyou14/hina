import { and, lt } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { userSession } from "../db/schema";
import { startIntervalTask } from "../util/interval-task";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export async function cleanupExpiredSessions(
  db: DbClient,
  nowMs: number = Date.now(),
): Promise<number> {
  const cutoffMs = nowMs - RETENTION_MS;
  const result = await db
    .delete(userSession)
    .where(and(lt(userSession.createdAtMs, cutoffMs), lt(userSession.expiresAtMs, nowMs)));
  return (result as { changes?: number } | undefined)?.changes ?? 0;
}

export function startSessionCleanupWorker(deps: { db: DbClient }) {
  return startIntervalTask({
    label: "session cleanup",
    intervalMs: CLEANUP_INTERVAL_MS,
    tick: async () => {
      const deleted = await cleanupExpiredSessions(deps.db);
      if (deleted > 0) {
        console.log(`session cleanup: deleted ${deleted} expired sessions`);
      }
    },
  });
}
