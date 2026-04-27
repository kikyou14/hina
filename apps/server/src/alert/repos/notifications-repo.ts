import { and, asc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { alertChannel, alertNotification } from "../../db/schema";
import type { AlertNotificationStatus } from "../types";

export type NotificationJob = {
  id: string;
  ruleId: string;
  subjectKey: string;
  channelId: string;
  kind: string;
  eventTsMs: number;
  payloadJson: string;
  status: AlertNotificationStatus;
  attempts: number;
  nextAttemptAtMs: number;
  createdAtMs: number;
  updatedAtMs: number;
};

export type PendingNotification = {
  id: string;
  ruleId: string;
  subjectKey: string;
  channelId: string;
  kind: string;
  payloadJson: string;
  attempts: number;
  nextAttemptAtMs: number;
  channelType: string;
  channelConfigJson: string;
  channelEnabled: boolean;
};

export async function enqueue(db: DbClient, jobs: NotificationJob[]): Promise<void> {
  if (jobs.length === 0) return;
  await db.insert(alertNotification).values(jobs).onConflictDoNothing();
}

export async function claimPendingBatch(
  db: DbClient,
  nowMs: number,
  limit: number,
  leaseMs: number,
): Promise<PendingNotification[]> {
  const candidates = await db
    .select({ id: alertNotification.id })
    .from(alertNotification)
    .where(
      and(eq(alertNotification.status, "pending"), lte(alertNotification.nextAttemptAtMs, nowMs)),
    )
    .orderBy(asc(alertNotification.nextAttemptAtMs), asc(alertNotification.createdAtMs))
    .limit(limit);

  if (candidates.length === 0) return [];

  const candidateIds = candidates.map((c) => c.id);
  const leaseUntilMs = nowMs + leaseMs;

  const claimed = await db
    .update(alertNotification)
    .set({ nextAttemptAtMs: leaseUntilMs, updatedAtMs: nowMs })
    .where(
      and(
        inArray(alertNotification.id, candidateIds),
        eq(alertNotification.status, "pending"),
        lte(alertNotification.nextAttemptAtMs, nowMs),
      ),
    )
    .returning({ id: alertNotification.id });

  if (claimed.length === 0) return [];

  const claimedIdSet = new Set(claimed.map((c) => c.id));

  const rows = await db
    .select({
      id: alertNotification.id,
      ruleId: alertNotification.ruleId,
      subjectKey: alertNotification.subjectKey,
      channelId: alertNotification.channelId,
      kind: alertNotification.kind,
      payloadJson: alertNotification.payloadJson,
      attempts: alertNotification.attempts,
      nextAttemptAtMs: alertNotification.nextAttemptAtMs,
      channelType: alertChannel.type,
      channelConfigJson: alertChannel.configJson,
      channelEnabled: alertChannel.enabled,
    })
    .from(alertNotification)
    .innerJoin(alertChannel, eq(alertNotification.channelId, alertChannel.id))
    .where(inArray(alertNotification.id, Array.from(claimedIdSet)));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered: PendingNotification[] = [];
  for (const id of candidateIds) {
    if (!claimedIdSet.has(id)) continue;
    const row = byId.get(id);
    if (row) ordered.push(row);
  }
  return ordered;
}

export async function releaseLease(
  db: DbClient,
  ids: string[],
  leaseUntilMs: number,
  nextAttemptAtMs: number,
  nowMs: number,
): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(alertNotification)
    .set({ nextAttemptAtMs, updatedAtMs: nowMs })
    .where(
      and(
        inArray(alertNotification.id, ids),
        eq(alertNotification.status, "pending"),
        eq(alertNotification.nextAttemptAtMs, leaseUntilMs),
      ),
    );
}

export async function markSent(db: DbClient, id: string, nowMs: number): Promise<void> {
  await db
    .update(alertNotification)
    .set({ status: "sent", sentAtMs: nowMs, updatedAtMs: nowMs })
    .where(eq(alertNotification.id, id));
}

export async function markRetry(
  db: DbClient,
  id: string,
  attempts: number,
  nextAttemptAtMs: number,
  lastError: string,
  nowMs: number,
): Promise<void> {
  await db
    .update(alertNotification)
    .set({ status: "pending", attempts, lastError, nextAttemptAtMs, updatedAtMs: nowMs })
    .where(eq(alertNotification.id, id));
}

export async function markDead(
  db: DbClient,
  id: string,
  attempts: number,
  lastError: string,
  nowMs: number,
): Promise<void> {
  await db
    .update(alertNotification)
    .set({ status: "dead", attempts, lastError, updatedAtMs: nowMs })
    .where(eq(alertNotification.id, id));
}

export async function checkCooldown(
  db: DbClient,
  ruleIds: string[],
  subjectKeys: string[],
  cutoffMs: number,
): Promise<Set<string>> {
  if (ruleIds.length === 0 || subjectKeys.length === 0) return new Set();

  const rows = await db
    .select({
      ruleId: alertNotification.ruleId,
      subjectKey: alertNotification.subjectKey,
    })
    .from(alertNotification)
    .where(
      and(
        inArray(alertNotification.ruleId, ruleIds),
        inArray(alertNotification.subjectKey, subjectKeys),
        gte(alertNotification.createdAtMs, cutoffMs),
        // Only count pending/sent — dead notifications should not suppress
        inArray(alertNotification.status, ["pending", "sent"]),
      ),
    );

  return new Set(rows.map((r) => `${r.ruleId}|${r.subjectKey}`));
}

export async function cleanupOldNotifications(
  db: DbClient,
  sentCutoffMs: number,
  deadCutoffMs: number,
): Promise<{ deletedSent: number; deletedDead: number }> {
  const sentResult = await db
    .delete(alertNotification)
    .where(
      and(eq(alertNotification.status, "sent"), lt(alertNotification.createdAtMs, sentCutoffMs)),
    );
  const deletedSent = (sentResult as { changes?: number } | undefined)?.changes ?? 0;

  const deadResult = await db
    .delete(alertNotification)
    .where(
      and(eq(alertNotification.status, "dead"), lt(alertNotification.createdAtMs, deadCutoffMs)),
    );
  const deletedDead = (deadResult as { changes?: number } | undefined)?.changes ?? 0;

  return { deletedSent, deletedDead };
}
