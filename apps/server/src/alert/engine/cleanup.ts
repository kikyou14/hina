import type { DbClient } from "../../db/client";
import { startIntervalTask } from "../../util/interval-task";
import {
  NOTIFICATION_CLEANUP_INTERVAL_MS,
  NOTIFICATION_DEAD_RETENTION_MS,
  NOTIFICATION_SENT_RETENTION_MS,
} from "../constants";
import { cleanupOldNotifications } from "../repos/notifications-repo";

// Runs every 6 hours, deletes sent (7d) and dead (30d) notifications.
export function startAlertNotificationCleanupWorker(deps: { db: DbClient }) {
  return startIntervalTask({
    label: "alert notification cleanup",
    intervalMs: NOTIFICATION_CLEANUP_INTERVAL_MS,
    tick: async () => {
      const nowMs = Date.now();
      const sentCutoffMs = nowMs - NOTIFICATION_SENT_RETENTION_MS;
      const deadCutoffMs = nowMs - NOTIFICATION_DEAD_RETENTION_MS;

      const { deletedSent, deletedDead } = await cleanupOldNotifications(
        deps.db,
        sentCutoffMs,
        deadCutoffMs,
      );

      if (deletedSent > 0 || deletedDead > 0) {
        console.log(`alert notification cleanup: deleted ${deletedSent} sent, ${deletedDead} dead`);
      }
    },
  });
}
