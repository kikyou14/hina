import { and, gt, inArray } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { userSession as userSessionTable } from "../db/schema";
import type { BrowserLiveHub } from "../live/hub";
import { createLogger } from "../logging/logger";
import { type StopIntervalTask, startIntervalTask } from "../util/interval-task";

const DEFAULT_REVALIDATION_INTERVAL_MS = 30_000;

const log = createLogger("auth.revalidation");

export async function checkSessionValidity(
  db: DbClient,
  tokenHashes: string[],
  nowMs: number = Date.now(),
): Promise<Set<string>> {
  if (tokenHashes.length === 0) return new Set();
  const rows = await db
    .select({ tokenHash: userSessionTable.tokenHash })
    .from(userSessionTable)
    .where(
      and(
        inArray(userSessionTable.tokenHash, tokenHashes),
        gt(userSessionTable.expiresAtMs, nowMs),
      ),
    );
  return new Set(rows.map((r) => r.tokenHash));
}

export type SessionRevalidationDeps = {
  db: DbClient;
  liveHub: Pick<BrowserLiveHub, "revalidateActiveSessions">;
  intervalMs?: number;
};

export function startSessionRevalidationWorker(deps: SessionRevalidationDeps): StopIntervalTask {
  const intervalMs = deps.intervalMs ?? DEFAULT_REVALIDATION_INTERVAL_MS;
  return startIntervalTask({
    label: "session revalidation",
    intervalMs,
    runOnStart: false,
    tick: async () => {
      const revoked = await deps.liveHub.revalidateActiveSessions((hashes) =>
        checkSessionValidity(deps.db, hashes),
      );
      if (revoked > 0) {
        log.info(`revoked ${revoked} session(s)`);
      }
    },
  });
}
