import type { DbClient } from "../../db/client";
import { createLogger } from "../../logging/logger";
import type { SiteConfigStore } from "../../settings/site-config";
import { mapWithConcurrency } from "../../util/concurrency";
import { clampText, isRecord, safeJsonParse } from "../../util/lang";
import { resolveNotifier as defaultResolveNotifier } from "../channels/registry";
import type { AnyNotifier, SendResult } from "../channels/types";
import {
  ALERT_DISPATCH_CHANNEL_CONCURRENCY,
  ALERT_DISPATCH_CLAIM_LEASE_MS,
  ALERT_DISPATCH_SEND_HARD_TIMEOUT_MS,
  ALERT_DISPATCH_TICK_DEADLINE_MS,
  ALERT_NOTIFICATION_BACKOFF_BASE_MS,
  ALERT_NOTIFICATION_BACKOFF_MAX_MS,
  ALERT_NOTIFICATION_MAX_ATTEMPTS,
  ALERT_NOTIFICATION_SEND_BATCH,
  MAX_ERROR_LEN,
} from "../constants";
import {
  claimPendingBatch,
  markDead,
  markRetry,
  markSent,
  releaseLease,
  type PendingNotification,
} from "../repos/notifications-repo";
import { parseAlertChannelType } from "../repos/parsing";
import type { AlertMessageV1 } from "../types";

const alertLog = createLogger("alert");

export type NotifierResolver = (type: string) => AnyNotifier | undefined;

export type SendTickTuning = {
  batchLimit?: number;
  leaseMs?: number;
  tickDeadlineMs?: number;
  channelConcurrency?: number;
  sendHardTimeoutMs?: number;
};

export type SendTickDeps = {
  db: DbClient;
  siteConfig: SiteConfigStore;
  resolveNotifier?: NotifierResolver;
  tuning?: SendTickTuning;
};

export async function sendTick(deps: SendTickDeps): Promise<void> {
  const t = deps.tuning;
  const batchLimit = t?.batchLimit ?? ALERT_NOTIFICATION_SEND_BATCH;
  const leaseMs = t?.leaseMs ?? ALERT_DISPATCH_CLAIM_LEASE_MS;
  const tickDeadlineMs = t?.tickDeadlineMs ?? ALERT_DISPATCH_TICK_DEADLINE_MS;
  const channelConcurrency = t?.channelConcurrency ?? ALERT_DISPATCH_CHANNEL_CONCURRENCY;
  const sendHardTimeoutMs = t?.sendHardTimeoutMs ?? ALERT_DISPATCH_SEND_HARD_TIMEOUT_MS;
  const resolve = deps.resolveNotifier ?? defaultResolveNotifier;

  const tickStartMs = Date.now();
  const batch = await claimPendingBatch(deps.db, tickStartMs, batchLimit, leaseMs);
  if (batch.length === 0) return;

  const leaseUntilMs = tickStartMs + leaseMs;

  const queues = groupByChannel(batch);
  const deadlineMs = tickStartMs + tickDeadlineMs;
  const startedQueueIndices = new Set<number>();

  const dispatchWork = mapWithConcurrency(queues, channelConcurrency, async (queue, qIdx) => {
    startedQueueIndices.add(qIdx);
    for (let i = 0; i < queue.length; i++) {
      if (Date.now() >= deadlineMs) {
        const skipped = queue.slice(i).map((r) => r.id);
        try {
          await releaseLease(deps.db, skipped, leaseUntilMs, tickStartMs, Date.now());
        } catch (err) {
          alertLog.error(`release lease failed: ids=${skipped.length}`, err);
        }
        return;
      }
      try {
        await dispatchOne(deps.db, deps.siteConfig, resolve, queue[i], sendHardTimeoutMs);
      } catch (err) {
        alertLog.error(`dispatch crashed: id=${queue[i].id} channel=${queue[i].channelType}`, err);
      }
    }
  });

  let dispatchSettled = false;
  const shepherd = dispatchWork
    .catch((err) => {
      alertLog.error(`dispatch pool crashed`, err);
    })
    .finally(() => {
      dispatchSettled = true;
    });

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlineElapsed = new Promise<void>((done) => {
    deadlineTimer = setTimeout(done, Math.max(0, deadlineMs - Date.now()));
  });
  await Promise.race([shepherd, deadlineElapsed]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  if (dispatchSettled) return;

  const unstartedIds: string[] = [];
  for (let i = 0; i < queues.length; i++) {
    if (startedQueueIndices.has(i)) continue;
    for (const row of queues[i]) unstartedIds.push(row.id);
  }
  if (unstartedIds.length === 0) return;
  try {
    await releaseLease(deps.db, unstartedIds, leaseUntilMs, tickStartMs, Date.now());
  } catch (err) {
    alertLog.error(`release lease failed: ids=${unstartedIds.length}`, err);
  }
}

function groupByChannel(rows: readonly PendingNotification[]): PendingNotification[][] {
  const byChannel = new Map<string, PendingNotification[]>();
  for (const row of rows) {
    const existing = byChannel.get(row.channelId);
    if (existing) existing.push(row);
    else byChannel.set(row.channelId, [row]);
  }
  return Array.from(byChannel.values());
}

async function dispatchOne(
  db: DbClient,
  siteConfig: SiteConfigStore,
  resolve: NotifierResolver,
  row: PendingNotification,
  sendHardTimeoutMs: number,
): Promise<void> {
  const startMs = Date.now();

  const channelType = parseAlertChannelType(row.channelType);
  if (!channelType) {
    alertLog.warn(`notification dead: id=${row.id} reason="unsupported channel type"`);
    await markDead(db, row.id, row.attempts, "unsupported channel type", startMs);
    return;
  }

  if (!row.channelEnabled) {
    await markDead(db, row.id, row.attempts, "channel disabled", startMs);
    return;
  }

  const notifier = resolve(channelType);
  if (!notifier) {
    alertLog.warn(`notification dead: id=${row.id} reason="no notifier for ${channelType}"`);
    await markDead(db, row.id, row.attempts, `no notifier for type: ${channelType}`, startMs);
    return;
  }

  const parsedPayload = safeJsonParse(row.payloadJson);
  if (!parsedPayload || !isRecord(parsedPayload) || parsedPayload["v"] !== 1) {
    alertLog.warn(`notification dead: id=${row.id} reason="invalid payload"`);
    await markDead(db, row.id, row.attempts, "invalid payload json", startMs);
    return;
  }
  const msg = parsedPayload as AlertMessageV1;

  const configResult = notifier.parseConfig(safeJsonParse(row.channelConfigJson) ?? {});
  if (!configResult.ok) {
    alertLog.warn(`notification dead: id=${row.id} reason="invalid channel config"`);
    await markDead(db, row.id, row.attempts, "invalid channel config", startMs);
    return;
  }

  const publicBaseUrl = siteConfig.getCurrent().publicBaseUrl || undefined;
  let sendResult: SendResult;
  try {
    sendResult = await withHardTimeout(
      notifier.send({ message: msg, publicBaseUrl, nowMs: startMs }, configResult.value),
      sendHardTimeoutMs,
    );
  } catch (err) {
    if (err instanceof HardTimeoutError) {
      const attempts = row.attempts + 1;
      alertLog.warn(
        `notification dead: id=${row.id} channel=${channelType} reason="hard timeout, outcome unknown"`,
      );
      await markDead(db, row.id, attempts, clampText(err.message, MAX_ERROR_LEN), Date.now());
      return;
    }
    alertLog.error(`notifier threw: id=${row.id} channel=${channelType}`, err);
    sendResult = {
      kind: "retryable",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const endMs = Date.now();

  if (sendResult.kind === "ok") {
    alertLog.info(`notification sent: id=${row.id} channel=${channelType}`);
    await markSent(db, row.id, endMs);
    return;
  }

  const attempts = row.attempts + 1;
  const lastError = clampText(sendResult.error, MAX_ERROR_LEN);

  if (sendResult.kind === "fatal" || attempts >= ALERT_NOTIFICATION_MAX_ATTEMPTS) {
    alertLog.warn(`notification dead: id=${row.id} channel=${channelType} error=${lastError}`);
    await markDead(db, row.id, attempts, lastError, endMs);
    return;
  }

  const nextAttemptAtMs = endMs + computeBackoffMs(attempts);
  await markRetry(db, row.id, attempts, nextAttemptAtMs, lastError, endMs);
}

class HardTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`send exceeded ${timeoutMs}ms hard timeout`);
    this.name = "HardTimeoutError";
  }
}

function withHardTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HardTimeoutError(timeoutMs)), timeoutMs);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function computeBackoffMs(attempts: number): number {
  const exp = Math.min(attempts, 10);
  const base = Math.min(
    ALERT_NOTIFICATION_BACKOFF_BASE_MS * 2 ** Math.max(0, exp - 1),
    ALERT_NOTIFICATION_BACKOFF_MAX_MS,
  );
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}
