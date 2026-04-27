import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../db/schema";
import {
  __internals,
  cleanupLoginAttempts,
  listLoginAttempts,
  recordLoginAttempt,
} from "./login-attempts";

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
    CREATE TABLE "login_attempt" (
      "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      "ts_ms" integer NOT NULL,
      "success" integer NOT NULL,
      "user_id" text,
      "username_attempted" text,
      "ip" text,
      "user_agent" text,
      "reason" text NOT NULL,
      FOREIGN KEY ("user_id") REFERENCES "user" ("id") ON DELETE set null
    );
    CREATE INDEX "idx_login_attempt_ts" ON "login_attempt" ("ts_ms");
    CREATE INDEX "idx_login_attempt_ip_ts" ON "login_attempt" ("ip", "ts_ms");
  `);

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

async function insertUser(db: ReturnType<typeof createTestDb>["db"], id: string) {
  await db.insert(schema.user).values({
    id,
    username: id,
    passwordHash: "x",
    role: "admin",
    createdAtMs: 0,
    updatedAtMs: 0,
  });
}

function countByIp(db: ReturnType<typeof createTestDb>["db"], ip: string): number {
  const row = db.$client
    .prepare(`SELECT count(*) AS n FROM login_attempt WHERE ip = ?`)
    .get(ip) as { n: number };
  return row.n;
}

describe("recordLoginAttempt", () => {
  test("inserts a success row with the provided fields", async () => {
    const { sqlite, db } = createTestDb();
    try {
      await insertUser(db, "u1");
      const result = await recordLoginAttempt(db, {
        nowMs: 1_000_000,
        success: true,
        reason: "ok",
        userId: "u1",
        usernameAttempted: "admin",
        ip: "203.0.113.5",
        userAgent: "curl/8",
      });
      expect(result).toEqual({ recorded: true, capped: false });

      const rows = await db.select().from(schema.loginAttempt);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        success: true,
        reason: "ok",
        userId: "u1",
        usernameAttempted: "admin",
        ip: "203.0.113.5",
        userAgent: "curl/8",
      });
    } finally {
      sqlite.close();
    }
  });

  test("attempts outlive the referenced user (user_id becomes NULL)", async () => {
    const { sqlite, db } = createTestDb();
    try {
      await insertUser(db, "u1");
      await recordLoginAttempt(db, {
        nowMs: 1_000,
        success: true,
        reason: "ok",
        userId: "u1",
        usernameAttempted: "admin",
        ip: "203.0.113.9",
        userAgent: null,
      });
      await recordLoginAttempt(db, {
        nowMs: 2_000,
        success: false,
        reason: "bad_password",
        userId: "u1",
        usernameAttempted: "admin",
        ip: "203.0.113.9",
        userAgent: null,
      });

      await db.delete(schema.user).where(eq(schema.user.id, "u1"));

      const rows = await db.select().from(schema.loginAttempt);
      expect(rows).toHaveLength(2);
      const nulled = await db
        .select()
        .from(schema.loginAttempt)
        .where(isNull(schema.loginAttempt.userId));
      expect(nulled).toHaveLength(2);
      // Contextual fields (IP, attempted username) must survive the deletion.
      expect(nulled.every((r) => r.usernameAttempted === "admin")).toBe(true);
      expect(nulled.every((r) => r.ip === "203.0.113.9")).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("clamps oversized username and user agent", async () => {
    const { sqlite, db } = createTestDb();
    try {
      await recordLoginAttempt(db, {
        nowMs: 1,
        success: false,
        reason: "no_user",
        userId: null,
        usernameAttempted: "a".repeat(1_000),
        ip: "198.51.100.1",
        userAgent: "b".repeat(10_000),
      });

      const rows = await db.select().from(schema.loginAttempt);
      expect(rows[0]!.usernameAttempted!.length).toBe(64);
      expect(rows[0]!.userAgent!.length).toBe(256);
    } finally {
      sqlite.close();
    }
  });

  test("caps per-IP failures within the 24h window", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const ip = "198.51.100.42";
      const baseMs = 10_000_000;
      const cap = __internals.PER_IP_CAP;

      const seed = db.$client.prepare(
        `INSERT INTO login_attempt (ts_ms, success, reason, ip) VALUES (?, 0, 'bad_password', ?)`,
      );
      for (let i = 0; i < cap; i++) seed.run(baseMs + i, ip);

      const blocked = await recordLoginAttempt(db, {
        nowMs: baseMs + cap + 1,
        success: false,
        reason: "bad_password",
        userId: null,
        usernameAttempted: "admin",
        ip,
        userAgent: null,
      });
      expect(blocked).toEqual({ recorded: false, capped: true });
      expect(countByIp(db, ip)).toBe(cap);

      // Success paths are never capped so genuine sign-ins still land.
      const ok = await recordLoginAttempt(db, {
        nowMs: baseMs + cap + 2,
        success: true,
        reason: "ok",
        userId: null,
        usernameAttempted: "admin",
        ip,
        userAgent: null,
      });
      expect(ok).toEqual({ recorded: true, capped: false });
      expect(countByIp(db, ip)).toBe(cap + 1);
    } finally {
      sqlite.close();
    }
  });

  test("per-IP cap ignores rows older than 24h", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const ip = "198.51.100.7";
      const now = 100_000_000;
      const stale = now - __internals.PER_IP_WINDOW_MS - 1_000;

      const seed = db.$client.prepare(
        `INSERT INTO login_attempt (ts_ms, success, reason, ip) VALUES (?, 0, 'bad_password', ?)`,
      );
      for (let i = 0; i < __internals.PER_IP_CAP + 50; i++) seed.run(stale + i, ip);

      const result = await recordLoginAttempt(db, {
        nowMs: now,
        success: false,
        reason: "bad_password",
        userId: null,
        usernameAttempted: "admin",
        ip,
        userAgent: null,
      });
      expect(result.recorded).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("per-IP cap does not apply when ip is unknown", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const seed = db.$client.prepare(
        `INSERT INTO login_attempt (ts_ms, success, reason, ip) VALUES (?, 0, 'bad_password', NULL)`,
      );
      for (let i = 0; i < __internals.PER_IP_CAP; i++) seed.run(1_000_000 + i);

      const result = await recordLoginAttempt(db, {
        nowMs: 2_000_000,
        success: false,
        reason: "bad_password",
        userId: null,
        usernameAttempted: "admin",
        ip: null,
        userAgent: null,
      });
      expect(result.recorded).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});

describe("cleanupLoginAttempts", () => {
  test("deletes rows older than the retention window", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const nowMs = 10 * __internals.RETENTION_MS;
      const seed = db.$client.prepare(
        `INSERT INTO login_attempt (ts_ms, success, reason) VALUES (?, 0, 'bad_password')`,
      );
      seed.run(nowMs - __internals.RETENTION_MS - DAY_MS);
      seed.run(nowMs - __internals.RETENTION_MS - 1);
      seed.run(nowMs - DAY_MS);

      const { deletedByAge } = await cleanupLoginAttempts(db, nowMs);
      expect(deletedByAge).toBe(2);

      const remaining = await db.select().from(schema.loginAttempt);
      expect(remaining).toHaveLength(1);
    } finally {
      sqlite.close();
    }
  });

  test("leaves rows untouched when total stays below the cap", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const seed = db.$client.prepare(
        `INSERT INTO login_attempt (ts_ms, success, reason) VALUES (?, 0, 'bad_password')`,
      );
      const now = Date.now();
      for (let i = 0; i < 200; i++) seed.run(now - i);

      const { deletedByAge, deletedByCap } = await cleanupLoginAttempts(db, now);
      expect(deletedByAge).toBe(0);
      expect(deletedByCap).toBe(0);

      const rows = await db.select().from(schema.loginAttempt);
      expect(rows).toHaveLength(200);
    } finally {
      sqlite.close();
    }
  });
});

describe("listLoginAttempts", () => {
  test("returns newest-first and filters to failures", async () => {
    const { sqlite, db } = createTestDb();
    try {
      await insertUser(db, "u1");
      await recordLoginAttempt(db, {
        nowMs: 1_000,
        success: false,
        reason: "no_user",
        userId: null,
        usernameAttempted: "root",
        ip: "203.0.113.1",
        userAgent: null,
      });
      await recordLoginAttempt(db, {
        nowMs: 2_000,
        success: true,
        reason: "ok",
        userId: "u1",
        usernameAttempted: "admin",
        ip: "203.0.113.2",
        userAgent: null,
      });
      await recordLoginAttempt(db, {
        nowMs: 3_000,
        success: false,
        reason: "bad_password",
        userId: "u1",
        usernameAttempted: "admin",
        ip: "203.0.113.3",
        userAgent: null,
      });

      const all = await listLoginAttempts(db, { limit: 10, offset: 0 });
      expect(all.rows.map((r) => r.tsMs)).toEqual([3_000, 2_000, 1_000]);
      expect(all.hasMore).toBe(false);

      const failures = await listLoginAttempts(db, {
        limit: 10,
        offset: 0,
        onlyFailures: true,
      });
      expect(failures.rows).toHaveLength(2);
      expect(failures.rows.every((r) => !r.success)).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  test("signals more pages via hasMore", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const seed = db.$client.prepare(
        `INSERT INTO login_attempt (ts_ms, success, reason) VALUES (?, 0, 'bad_password')`,
      );
      for (let i = 0; i < 5; i++) seed.run(1_000 + i);

      const page = await listLoginAttempts(db, { limit: 2, offset: 0 });
      expect(page.rows).toHaveLength(2);
      expect(page.hasMore).toBe(true);

      const tail = await listLoginAttempts(db, { limit: 2, offset: 4 });
      expect(tail.rows).toHaveLength(1);
      expect(tail.hasMore).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
