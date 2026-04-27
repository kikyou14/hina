import { and, eq, gt } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { user as userTable, userSession as userSessionTable } from "../db/schema";
import { createLogger } from "../logging/logger";
import { sha256Hex } from "../util/hash";
import { randomBase64Url } from "../util/random";

const log = createLogger("auth");

export const SESSION_COOKIE_NAME = "hina_session";

export type AuthUser = {
  id: string;
  username: string;
  role: string;
};

export type SessionLookupResult = {
  user: AuthUser;
  tokenHash: string;
  expiresAtMs: number;
};

export function parseBearerToken(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) return null;
  const token = trimmed.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

export function hashSessionToken(token: string): string {
  return sha256Hex(token);
}

export async function createSession(
  db: DbClient,
  args: {
    userId: string;
    nowMs: number;
    ttlMs: number;
    ip?: string;
    userAgent?: string;
  },
): Promise<{ token: string; tokenHash: string; expiresAtMs: number }> {
  const token = randomBase64Url(32);
  const tokenHash = hashSessionToken(token);
  const expiresAtMs = args.nowMs + Math.max(0, args.ttlMs);

  await db.insert(userSessionTable).values({
    tokenHash,
    userId: args.userId,
    createdAtMs: args.nowMs,
    expiresAtMs,
    lastSeenAtMs: args.nowMs,
    ip: args.ip,
    userAgent: args.userAgent,
  });

  return { token, tokenHash, expiresAtMs };
}

export async function revokeSession(
  db: DbClient,
  tokenHash: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await db
    .update(userSessionTable)
    .set({ expiresAtMs: nowMs, lastSeenAtMs: nowMs })
    .where(eq(userSessionTable.tokenHash, tokenHash));
}

export async function revokeUserSessions(
  db: DbClient,
  userId: string,
  nowMs: number = Date.now(),
): Promise<void> {
  await db
    .update(userSessionTable)
    .set({ expiresAtMs: nowMs, lastSeenAtMs: nowMs })
    .where(eq(userSessionTable.userId, userId));
}

export async function findValidSession(
  db: DbClient,
  args: { tokenHash: string; nowMs: number },
): Promise<SessionLookupResult | null> {
  const rows = await db
    .select({
      tokenHash: userSessionTable.tokenHash,
      expiresAtMs: userSessionTable.expiresAtMs,
      userId: userTable.id,
      username: userTable.username,
      role: userTable.role,
    })
    .from(userSessionTable)
    .innerJoin(userTable, eq(userSessionTable.userId, userTable.id))
    .where(
      and(
        eq(userSessionTable.tokenHash, args.tokenHash),
        gt(userSessionTable.expiresAtMs, args.nowMs),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    user: { id: r.userId, username: r.username, role: r.role },
    tokenHash: r.tokenHash,
    expiresAtMs: r.expiresAtMs,
  };
}

const DEFAULT_TOUCH_INTERVAL_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;

type SessionTouchEntry = {
  lastTouchMs: number;
  expiresAtMs: number;
};

export class SessionTouchThrottler {
  private readonly entries = new Map<string, SessionTouchEntry>();
  private lastSweepAtMs = 0;

  constructor(
    private readonly intervalMs: number = DEFAULT_TOUCH_INTERVAL_MS,
    private readonly sweepIntervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
  ) {}

  async validateAndTouch(
    db: DbClient,
    args: { tokenHash: string; nowMs: number },
  ): Promise<SessionLookupResult | null> {
    const session = await findValidSession(db, args);
    if (!session) {
      this.entries.delete(args.tokenHash);
      this.maybeSweep(args.nowMs);
      return null;
    }

    const prev = this.entries.get(args.tokenHash);
    if (prev === undefined || args.nowMs - prev.lastTouchMs >= this.intervalMs) {
      this.entries.set(args.tokenHash, {
        lastTouchMs: args.nowMs,
        expiresAtMs: session.expiresAtMs,
      });
      db.update(userSessionTable)
        .set({ lastSeenAtMs: args.nowMs })
        .where(eq(userSessionTable.tokenHash, args.tokenHash))
        .execute()
        .catch((err) => log.warn("session touch failed", err));
    }

    this.maybeSweep(args.nowMs);
    return session;
  }

  evict(tokenHash: string): void {
    this.entries.delete(tokenHash);
  }

  evictAll(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }

  private maybeSweep(nowMs: number): void {
    if (nowMs - this.lastSweepAtMs < this.sweepIntervalMs) return;
    this.lastSweepAtMs = nowMs;
    for (const [hash, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(hash);
    }
  }
}
