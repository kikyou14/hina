import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { AgentRegistry } from "../agents/registry";
import type { DbClient } from "../db/client";
import * as schema from "../db/schema";
import { getMigrationsFolder } from "../paths";
import { addMonthsUtc, advanceExpiry, renewExpiredAgents } from "./renewal";

function utc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

describe("addMonthsUtc", () => {
  test("basic: +1 month", () => {
    expect(addMonthsUtc(utc(2026, 1, 15), 1)).toBe(utc(2026, 2, 15));
  });

  test("clamps month-end overflow: Jan 31 + 1 month → Feb 28", () => {
    expect(addMonthsUtc(utc(2026, 1, 31), 1)).toBe(utc(2026, 2, 28));
  });

  test("leap year: Jan 31 + 1 month → Feb 29", () => {
    expect(addMonthsUtc(utc(2028, 1, 31), 1)).toBe(utc(2028, 2, 29));
  });

  test("year boundary: Dec 15 + 1 month → Jan 15 next year", () => {
    expect(addMonthsUtc(utc(2026, 12, 15), 1)).toBe(utc(2027, 1, 15));
  });

  test("+3 months (quarterly)", () => {
    expect(addMonthsUtc(utc(2026, 1, 31), 3)).toBe(utc(2026, 4, 30));
  });

  test("+12 months (annual)", () => {
    expect(addMonthsUtc(utc(2026, 3, 15), 12)).toBe(utc(2027, 3, 15));
  });

  test("+24 months (biennial)", () => {
    expect(addMonthsUtc(utc(2026, 6, 30), 24)).toBe(utc(2028, 6, 30));
  });

  test("+36 months (triennial)", () => {
    expect(addMonthsUtc(utc(2026, 6, 30), 36)).toBe(utc(2029, 6, 30));
  });

  test("leap day + 12 months → Feb 28 non-leap year", () => {
    expect(addMonthsUtc(utc(2028, 2, 29), 12)).toBe(utc(2029, 2, 28));
  });
});

describe("advanceExpiry", () => {
  test("advances past nowMs by one cycle", () => {
    const expired = utc(2026, 3, 1);
    const now = utc(2026, 3, 15);
    expect(advanceExpiry(expired, "monthly", now)).toBe(utc(2026, 4, 1));
  });

  test("advances multiple cycles when far in the past", () => {
    const expired = utc(2026, 1, 1);
    const now = utc(2026, 6, 15);
    // monthly: needs to advance 6 times to get past June 15
    expect(advanceExpiry(expired, "monthly", now)).toBe(utc(2026, 7, 1));
  });

  test("annual cycle: advances by whole years", () => {
    const expired = utc(2024, 3, 1);
    const now = utc(2026, 5, 10);
    // 2024-03-01 → 2025-03-01 → 2026-03-01 (still <= now) → 2027-03-01
    expect(advanceExpiry(expired, "annual", now)).toBe(utc(2027, 3, 1));
  });

  test("returns null for unknown cycle", () => {
    expect(advanceExpiry(utc(2026, 1, 1), "lifetime", Date.now())).toBeNull();
    expect(advanceExpiry(utc(2026, 1, 1), "unknown", Date.now())).toBeNull();
  });

  test("quarterly cycle", () => {
    const expired = utc(2026, 1, 15);
    const now = utc(2026, 5, 1);
    // 2026-01-15 → 2026-04-15 (still <= now) → 2026-07-15
    expect(advanceExpiry(expired, "quarterly", now)).toBe(utc(2026, 7, 15));
  });

  test("triennial cycle", () => {
    const expired = utc(2026, 1, 15);
    const now = utc(2028, 12, 1);
    expect(advanceExpiry(expired, "triennial", now)).toBe(utc(2029, 1, 15));
  });

  test("expired exactly at nowMs still advances", () => {
    const ts = utc(2026, 6, 1);
    expect(advanceExpiry(ts, "monthly", ts)).toBe(utc(2026, 7, 1));
  });

  test("month-end does not drift across multiple advances", () => {
    const expired = utc(2026, 1, 31); // Jan 31
    const now = utc(2026, 5, 1);
    // n=1: Feb 28, n=2: Mar 31, n=3: Apr 30 (all <= now), n=4: May 31 > now
    expect(advanceExpiry(expired, "monthly", now)).toBe(utc(2026, 5, 31));
  });

  test("month-end drift: semiannual from Aug 31", () => {
    const expired = utc(2025, 8, 31); // Aug 31
    const now = utc(2026, 4, 1);
    // +6m = Feb 28 (still <= now) → +12m = Aug 31
    expect(advanceExpiry(expired, "semiannual", now)).toBe(utc(2026, 8, 31));
  });
});

function createTestDb(): { db: DbClient; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema }) as DbClient;
  migrate(db, { migrationsFolder: getMigrationsFolder() });
  return { db, sqlite };
}

describe("renewExpiredAgents registry sync", () => {
  let db: DbClient;
  let sqlite: Database;
  let registry: AgentRegistry;

  beforeEach(() => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
    registry = new AgentRegistry(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  async function seedRenewable(args: {
    id: string;
    expiresAtMs: number;
    cycle: string;
    lastSeenAtMs: number;
  }) {
    const nowMs = 1_700_000_000_000;
    await db.insert(schema.agent).values({
      id: args.id,
      tokenHash: `hash-${args.id}`,
      name: args.id,
      isPublic: true,
      displayOrder: 0,
      tagsJson: "[]",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    await db.insert(schema.agentStatus).values({
      agentId: args.id,
      online: true,
      lastSeenAtMs: args.lastSeenAtMs,
      updatedAtMs: nowMs,
    });
    await db.insert(schema.agentBilling).values({
      agentId: args.id,
      quotaBytes: 0,
      mode: "sum",
      resetDay: 1,
      updatedAtMs: nowMs,
    });
    await db.insert(schema.agentPricing).values({
      agentId: args.id,
      currency: "USD",
      cycle: args.cycle,
      amountUnit: 100,
      expiresAtMs: args.expiresAtMs,
      updatedAtMs: nowMs,
    });
  }

  test("renewal updates the registry so snapshots reflect the new expiry", async () => {
    const oldExpiry = utc(2026, 1, 1);
    const nowMs = utc(2026, 1, 15);
    await seedRenewable({
      id: "a1",
      expiresAtMs: oldExpiry,
      cycle: "monthly",
      lastSeenAtMs: nowMs - 1000,
    });
    await registry.load();

    // Before renewal: registry still sees the old, expired pricing.
    expect(registry.getSummary("a1")?.pricing?.expiresAtMs).toBe(oldExpiry);

    const count = await renewExpiredAgents({ db, registry }, nowMs);
    expect(count).toBe(1);

    // Registry now reflects the advanced expiry without any extra patch/rescan.
    const expected = utc(2026, 2, 1); // one monthly cycle past oldExpiry = Feb 1
    expect(registry.getSummary("a1")?.pricing?.expiresAtMs).toBe(expected);
  });

  test("renewal skips agents not in the registry but still bumps the DB", async () => {
    const oldExpiry = utc(2026, 1, 1);
    const nowMs = utc(2026, 1, 15);
    await seedRenewable({
      id: "a1",
      expiresAtMs: oldExpiry,
      cycle: "monthly",
      lastSeenAtMs: nowMs - 1000,
    });
    // Note: registry.load() intentionally NOT called → registry is empty.

    // Should not throw even though the registry doesn't know about this agent.
    const count = await renewExpiredAgents({ db, registry }, nowMs);
    expect(count).toBe(1);
    expect(registry.size()).toBe(0);
  });

  test("broadcast only covers ids that actually synced into the registry", async () => {
    // Regression for the "stale agent_remove" noise: previously the worker
    // broadcast every DB-updated id regardless of whether the registry had
    // the agent. For absent entries that turns into a stray `agent_remove`.
    const oldExpiry = utc(2026, 1, 1);
    const nowMs = utc(2026, 1, 15);
    await seedRenewable({
      id: "present",
      expiresAtMs: oldExpiry,
      cycle: "monthly",
      lastSeenAtMs: nowMs - 1000,
    });
    await seedRenewable({
      id: "absent",
      expiresAtMs: oldExpiry,
      cycle: "monthly",
      lastSeenAtMs: nowMs - 1000,
    });

    // Load the registry, then evict one entry to simulate a concurrent DELETE
    // landing between the loadExpiredAgents SELECT and syncPricingFromDb.
    await registry.load();
    registry.remove("absent");

    const broadcastCalls: string[][] = [];
    const fakeHub = {
      publishAgentChanges: (ids: string[]) => broadcastCalls.push([...ids]),
    } as unknown as Parameters<typeof renewExpiredAgents>[0]["liveHub"];

    const count = await renewExpiredAgents({ db, registry, liveHub: fakeHub }, nowMs);

    // Both DB rows were bumped forward.
    expect(count).toBe(2);
    // But only the id still in the registry reached the live hub.
    expect(broadcastCalls).toEqual([["present"]]);
  });
});
