import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import { checkSessionValidity } from "./revalidation";
import { createSession, hashSessionToken } from "./session";

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

async function seedUser(
  db: ReturnType<typeof createTestDb>["db"],
  args: { id: string; username: string; nowMs: number },
) {
  await db.insert(schema.user).values({
    id: args.id,
    username: args.username,
    passwordHash: "hash",
    role: "admin",
    createdAtMs: args.nowMs,
    updatedAtMs: args.nowMs,
  });
}

describe("checkSessionValidity", () => {
  test("returns empty set on empty input without hitting db", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const valid = await checkSessionValidity(db, [], 4_200_000_000_000);
      expect(valid.size).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test("returns hashes whose session row is still alive", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const nowMs = 4_200_000_000_000;
      await seedUser(db, { id: "user-1", username: "alice", nowMs });

      const session = await createSession(db, {
        userId: "user-1",
        nowMs,
        ttlMs: 7 * DAY_MS,
      });

      const valid = await checkSessionValidity(db, [session.tokenHash], nowMs + DAY_MS);
      expect(valid).toEqual(new Set([session.tokenHash]));
    } finally {
      sqlite.close();
    }
  });

  test("excludes hashes whose session does not exist", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const nowMs = 4_200_000_000_000;
      const valid = await checkSessionValidity(db, [hashSessionToken("ghost")], nowMs);
      expect(valid.size).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test("excludes hashes whose expires_at_ms has passed", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const nowMs = 4_200_000_000_000;
      await seedUser(db, { id: "user-1", username: "alice", nowMs });

      const session = await createSession(db, {
        userId: "user-1",
        nowMs,
        ttlMs: DAY_MS,
      });

      const valid = await checkSessionValidity(db, [session.tokenHash], session.expiresAtMs + 1);
      expect(valid.size).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test("partitions a mixed batch by validity in a single query", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const nowMs = 4_200_000_000_000;
      await seedUser(db, { id: "user-1", username: "alice", nowMs });
      await seedUser(db, { id: "user-2", username: "bob", nowMs });

      const aliveSession = await createSession(db, {
        userId: "user-1",
        nowMs,
        ttlMs: 7 * DAY_MS,
      });
      const expiredSession = await createSession(db, {
        userId: "user-2",
        nowMs,
        ttlMs: DAY_MS,
      });

      const valid = await checkSessionValidity(
        db,
        [aliveSession.tokenHash, expiredSession.tokenHash, hashSessionToken("ghost")],
        expiredSession.expiresAtMs + 1,
      );
      expect(valid).toEqual(new Set([aliveSession.tokenHash]));
    } finally {
      sqlite.close();
    }
  });
});
