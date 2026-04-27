import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { cleanupExpiredSessions } from "./cleanup";
import { createSession, revokeSession } from "./session";

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

describe("cleanupExpiredSessions", () => {
  test("deletes old revoked sessions based on creation time", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const nowMs = 4_200_000_000_000;
      const createdAtMs = nowMs - 120 * DAY_MS;

      await db.insert(schema.user).values({
        id: "user-1",
        username: "admin",
        passwordHash: "hash",
        role: "admin",
        createdAtMs,
        updatedAtMs: createdAtMs,
      });

      const session = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: 7 * DAY_MS,
      });
      await revokeSession(db, session.tokenHash, nowMs - DAY_MS);

      expect(await cleanupExpiredSessions(db, nowMs)).toBe(1);

      const rows = await db
        .select({ tokenHash: schema.userSession.tokenHash })
        .from(schema.userSession)
        .where(eq(schema.userSession.tokenHash, session.tokenHash));
      expect(rows).toHaveLength(0);
    } finally {
      sqlite.close();
    }
  });

  test("keeps old sessions that are still active", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const nowMs = 4_200_000_000_000;
      const createdAtMs = nowMs - 120 * DAY_MS;

      await db.insert(schema.user).values({
        id: "user-1",
        username: "admin",
        passwordHash: "hash",
        role: "admin",
        createdAtMs,
        updatedAtMs: createdAtMs,
      });

      const session = await createSession(db, {
        userId: "user-1",
        nowMs: createdAtMs,
        ttlMs: 180 * DAY_MS,
      });

      expect(await cleanupExpiredSessions(db, nowMs)).toBe(0);

      const rows = await db
        .select({ tokenHash: schema.userSession.tokenHash })
        .from(schema.userSession)
        .where(eq(schema.userSession.tokenHash, session.tokenHash));
      expect(rows).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });
});
