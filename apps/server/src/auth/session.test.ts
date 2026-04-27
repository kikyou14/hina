import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import {
  SessionTouchThrottler,
  createSession,
  findValidSession,
  hashSessionToken,
  revokeSession,
} from "./session";

const DAY_MS = 24 * 60 * 60 * 1000;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(`
    CREATE TABLE "user" (
      "id" text PRIMARY KEY NOT NULL,
      "username" text NOT NULL,
      "password_hash" text NOT NULL,
      "role" text NOT NULL,
      "created_at_ms" integer NOT NULL,
      "updated_at_ms" integer NOT NULL,
      "last_login_at_ms" integer
    );
    CREATE UNIQUE INDEX "user_username_unique" ON "user" ("username");
    CREATE TABLE "user_session" (
      "token_hash" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL,
      "created_at_ms" integer NOT NULL,
      "expires_at_ms" integer NOT NULL,
      "last_seen_at_ms" integer NOT NULL,
      "ip" text,
      "user_agent" text,
      FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE cascade
    );
    CREATE INDEX "idx_user_session_user_id" ON "user_session" ("user_id");
    CREATE INDEX "idx_user_session_expires" ON "user_session" ("expires_at_ms");
  `);

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
  };
}

async function seedUser(db: ReturnType<typeof createTestDb>["db"], nowMs: number) {
  await db.insert(schema.user).values({
    id: "user-1",
    username: "alice",
    passwordHash: "hash",
    role: "admin",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

function getLastSeenAtMs(
  db: ReturnType<typeof createTestDb>["db"],
  tokenHash: string,
): Promise<number | undefined> {
  return db
    .select({ lastSeenAtMs: schema.userSession.lastSeenAtMs })
    .from(schema.userSession)
    .where(eq(schema.userSession.tokenHash, tokenHash))
    .then((rows) => rows[0]?.lastSeenAtMs);
}

describe("findValidSession", () => {
  test("returns user info on valid session", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const createdAtMs = 4_200_000_000_000;
      await seedUser(db, createdAtMs);

      const session = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: 7 * DAY_MS,
      });

      const result = await findValidSession(db, {
        tokenHash: session.tokenHash,
        nowMs: createdAtMs + DAY_MS,
      });

      expect(result).not.toBeNull();
      expect(result!.user).toEqual({ id: "user-1", username: "alice", role: "admin" });
      expect(result!.tokenHash).toBe(session.tokenHash);
      expect(result!.expiresAtMs).toBe(session.expiresAtMs);
    } finally {
      sqlite.close();
    }
  });

  test("returns null on expired session", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const createdAtMs = 4_200_000_000_000;
      await seedUser(db, createdAtMs);

      const session = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: DAY_MS,
      });

      const result = await findValidSession(db, {
        tokenHash: session.tokenHash,
        nowMs: session.expiresAtMs + 1,
      });
      expect(result).toBeNull();
    } finally {
      sqlite.close();
    }
  });

  test("returns null when token does not match any session", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const result = await findValidSession(db, {
        tokenHash: hashSessionToken("nonexistent"),
        nowMs: 4_200_000_000_000,
      });
      expect(result).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});

describe("SessionTouchThrottler", () => {
  test("first call writes lastSeenAtMs", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const createdAtMs = 4_200_000_000_000;
      await seedUser(db, createdAtMs);

      const session = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: 7 * DAY_MS,
      });

      const throttler = new SessionTouchThrottler(60_000);
      const hitAtMs = createdAtMs + DAY_MS;
      const result = await throttler.validateAndTouch(db, {
        tokenHash: session.tokenHash,
        nowMs: hitAtMs,
      });

      expect(result).not.toBeNull();
      expect(result!.user).toEqual({ id: "user-1", username: "alice", role: "admin" });

      // fire-and-forget write needs a tick to settle
      await Bun.sleep(10);
      expect(await getLastSeenAtMs(db, session.tokenHash)).toBe(hitAtMs);
    } finally {
      sqlite.close();
    }
  });

  test("second call within interval skips write", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const createdAtMs = 4_200_000_000_000;
      await seedUser(db, createdAtMs);

      const session = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: 7 * DAY_MS,
      });

      const throttler = new SessionTouchThrottler(60_000);
      const t1 = createdAtMs + DAY_MS;
      await throttler.validateAndTouch(db, { tokenHash: session.tokenHash, nowMs: t1 });
      await Bun.sleep(10);

      const t2 = t1 + 30_000; // 30s later, within 60s interval
      await throttler.validateAndTouch(db, { tokenHash: session.tokenHash, nowMs: t2 });
      await Bun.sleep(10);

      expect(await getLastSeenAtMs(db, session.tokenHash)).toBe(t1);
    } finally {
      sqlite.close();
    }
  });

  test("call after interval elapsed writes again", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const createdAtMs = 4_200_000_000_000;
      await seedUser(db, createdAtMs);

      const session = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: 7 * DAY_MS,
      });

      const throttler = new SessionTouchThrottler(60_000);
      const t1 = createdAtMs + DAY_MS;
      await throttler.validateAndTouch(db, { tokenHash: session.tokenHash, nowMs: t1 });
      await Bun.sleep(10);

      const t2 = t1 + 61_000; // 61s later, past 60s interval
      await throttler.validateAndTouch(db, { tokenHash: session.tokenHash, nowMs: t2 });
      await Bun.sleep(10);

      expect(await getLastSeenAtMs(db, session.tokenHash)).toBe(t2);
    } finally {
      sqlite.close();
    }
  });

  test("returns null for expired session and does not write", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const createdAtMs = 4_200_000_000_000;
      await seedUser(db, createdAtMs);

      const session = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: DAY_MS,
      });

      const throttler = new SessionTouchThrottler(60_000);
      const result = await throttler.validateAndTouch(db, {
        tokenHash: session.tokenHash,
        nowMs: session.expiresAtMs + 1,
      });

      expect(result).toBeNull();
      expect(await getLastSeenAtMs(db, session.tokenHash)).toBe(createdAtMs);
    } finally {
      sqlite.close();
    }
  });

  test("evict clears throttle state for a token", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const createdAtMs = 4_200_000_000_000;
      await seedUser(db, createdAtMs);

      const session = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: 7 * DAY_MS,
      });

      const throttler = new SessionTouchThrottler(60_000);
      const t1 = createdAtMs + DAY_MS;
      await throttler.validateAndTouch(db, { tokenHash: session.tokenHash, nowMs: t1 });
      await Bun.sleep(10);

      throttler.evict(session.tokenHash);

      // immediate re-call should write again since throttle state was cleared
      const t2 = t1 + 1_000;
      await throttler.validateAndTouch(db, { tokenHash: session.tokenHash, nowMs: t2 });
      await Bun.sleep(10);

      expect(await getLastSeenAtMs(db, session.tokenHash)).toBe(t2);
    } finally {
      sqlite.close();
    }
  });

  test("drops throttle entry when session lookup fails", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const createdAtMs = 4_200_000_000_000;
      await seedUser(db, createdAtMs);

      const session = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: 7 * DAY_MS,
      });

      const throttler = new SessionTouchThrottler(60_000);
      await throttler.validateAndTouch(db, {
        tokenHash: session.tokenHash,
        nowMs: createdAtMs,
      });
      await Bun.sleep(10);
      expect(throttler.size()).toBe(1);

      await revokeSession(db, session.tokenHash, createdAtMs + 1_000);

      const result = await throttler.validateAndTouch(db, {
        tokenHash: session.tokenHash,
        nowMs: createdAtMs + 2_000,
      });
      expect(result).toBeNull();
      expect(throttler.size()).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test("sweeps expired entries on subsequent calls", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const createdAtMs = 4_200_000_000_000;
      await seedUser(db, createdAtMs);

      const shortLived = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: 60_000,
      });
      const longLived = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: 7 * DAY_MS,
      });

      // sweepIntervalMs=1_000 so the second call below crosses the sweep window.
      const throttler = new SessionTouchThrottler(60_000, 1_000);
      await throttler.validateAndTouch(db, {
        tokenHash: shortLived.tokenHash,
        nowMs: createdAtMs,
      });
      await Bun.sleep(10);
      await throttler.validateAndTouch(db, {
        tokenHash: longLived.tokenHash,
        nowMs: createdAtMs,
      });
      await Bun.sleep(10);
      expect(throttler.size()).toBe(2);

      // shortLived is past its DB expiry; the long-lived call also crosses
      // the sweep window and should prune the stale entry without touching
      // shortLived directly.
      const wellAfterShortLivedExpiry = createdAtMs + 120_000;
      await throttler.validateAndTouch(db, {
        tokenHash: longLived.tokenHash,
        nowMs: wellAfterShortLivedExpiry,
      });
      await Bun.sleep(10);
      expect(throttler.size()).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
