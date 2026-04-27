import { and, desc, eq, gt, lt, sql } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { loginAttempt } from "../db/schema";
import { createLogger } from "../logging/logger";
import { startIntervalTask } from "../util/interval-task";

export const LOGIN_ATTEMPT_REASONS = ["ok", "no_user", "bad_password"] as const;
export type LoginAttemptReason = (typeof LOGIN_ATTEMPT_REASONS)[number];

const USERNAME_MAX_LEN = 64;
const UA_MAX_LEN = 256;
const IP_MAX_LEN = 64;

const PER_IP_WINDOW_MS = 24 * 60 * 60 * 1000;
const PER_IP_CAP = 500;

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const GLOBAL_ROW_CAP = 500_000;
const GLOBAL_TRIM_TARGET_RATIO = 0.9;

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

const log = createLogger("auth");

function clamp(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (value.length === 0) return null;
  return value.length <= max ? value : value.slice(0, max);
}

export type RecordLoginAttemptArgs = {
  nowMs: number;
  success: boolean;
  reason: LoginAttemptReason;
  userId: string | null;
  usernameAttempted: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type RecordLoginAttemptResult = { recorded: boolean; capped: boolean };

export async function recordLoginAttempt(
  db: DbClient,
  args: RecordLoginAttemptArgs,
): Promise<RecordLoginAttemptResult> {
  const ip = clamp(args.ip, IP_MAX_LEN);

  if (!args.success && ip) {
    const cutoff = args.nowMs - PER_IP_WINDOW_MS;
    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(loginAttempt)
      .where(and(eq(loginAttempt.ip, ip), gt(loginAttempt.tsMs, cutoff)));
    const recent = rows[0]?.n ?? 0;
    if (recent >= PER_IP_CAP) {
      log.warn(`login_attempt capped: ip=${ip} window=24h count=${recent}`);
      return { recorded: false, capped: true };
    }
  }

  await db.insert(loginAttempt).values({
    tsMs: args.nowMs,
    success: args.success,
    userId: args.userId,
    usernameAttempted: clamp(args.usernameAttempted, USERNAME_MAX_LEN),
    ip,
    userAgent: clamp(args.userAgent, UA_MAX_LEN),
    reason: args.reason,
  });
  return { recorded: true, capped: false };
}

export async function cleanupLoginAttempts(
  db: DbClient,
  nowMs: number = Date.now(),
): Promise<{ deletedByAge: number; deletedByCap: number }> {
  const cutoff = nowMs - RETENTION_MS;
  const ageResult = await db.delete(loginAttempt).where(lt(loginAttempt.tsMs, cutoff));
  const deletedByAge = (ageResult as { changes?: number } | undefined)?.changes ?? 0;

  const totalRows = await db.select({ n: sql<number>`count(*)` }).from(loginAttempt);
  const total = totalRows[0]?.n ?? 0;

  let deletedByCap = 0;
  if (total > GLOBAL_ROW_CAP) {
    const target = Math.floor(GLOBAL_ROW_CAP * GLOBAL_TRIM_TARGET_RATIO);
    const toDelete = Math.max(0, total - target);
    if (toDelete > 0) {
      const capResult = await db.run(sql`
        DELETE FROM ${loginAttempt}
        WHERE ${loginAttempt.id} IN (
          SELECT ${loginAttempt.id} FROM ${loginAttempt}
          ORDER BY ${loginAttempt.id} ASC
          LIMIT ${toDelete}
        )
      `);
      deletedByCap = (capResult as { changes?: number } | undefined)?.changes ?? 0;
    }
  }

  return { deletedByAge, deletedByCap };
}

export function startLoginAttemptCleanupWorker(deps: { db: DbClient }) {
  return startIntervalTask({
    label: "login_attempt cleanup",
    intervalMs: CLEANUP_INTERVAL_MS,
    tick: async () => {
      const { deletedByAge, deletedByCap } = await cleanupLoginAttempts(deps.db);
      if (deletedByAge > 0 || deletedByCap > 0) {
        log.info(`login_attempt cleanup: aged=${deletedByAge} capped=${deletedByCap}`);
      }
    },
  });
}

export type LoginAttemptListRow = {
  tsMs: number;
  success: boolean;
  ip: string | null;
  userAgent: string | null;
  reason: string;
  usernameAttempted: string | null;
};

export type ListLoginAttemptsArgs = {
  limit: number;
  offset: number;
  onlyFailures?: boolean;
};

export async function listLoginAttempts(
  db: DbClient,
  args: ListLoginAttemptsArgs,
): Promise<{ rows: LoginAttemptListRow[]; hasMore: boolean }> {
  const whereClause = args.onlyFailures ? eq(loginAttempt.success, false) : undefined;

  const rows = await db
    .select({
      tsMs: loginAttempt.tsMs,
      success: loginAttempt.success,
      ip: loginAttempt.ip,
      userAgent: loginAttempt.userAgent,
      reason: loginAttempt.reason,
      usernameAttempted: loginAttempt.usernameAttempted,
    })
    .from(loginAttempt)
    .where(whereClause)
    .orderBy(desc(loginAttempt.tsMs), desc(loginAttempt.id))
    .limit(args.limit + 1)
    .offset(args.offset);

  const hasMore = rows.length > args.limit;
  return { rows: hasMore ? rows.slice(0, args.limit) : rows, hasMore };
}

export const __internals = {
  PER_IP_CAP,
  PER_IP_WINDOW_MS,
  RETENTION_MS,
  GLOBAL_ROW_CAP,
  GLOBAL_TRIM_TARGET_RATIO,
};
