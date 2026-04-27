import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { DbClient } from "../db/client";
import * as schema from "../db/schema";
import { getMigrationsFolder } from "../paths";
import { AgentRegistry } from "./registry";

function createTestDb(): { db: DbClient; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema }) as DbClient;
  migrate(db, { migrationsFolder: getMigrationsFolder() });
  return { db, sqlite };
}

async function seedAgent(
  db: DbClient,
  args: { id: string; name: string; isPublic?: boolean; displayOrder?: number; groupId?: string },
) {
  const nowMs = 1_700_000_000_000;
  await db.insert(schema.agent).values({
    id: args.id,
    tokenHash: `hash-${args.id}`,
    name: args.name,
    isPublic: args.isPublic ?? true,
    displayOrder: args.displayOrder ?? 0,
    tagsJson: "[]",
    groupId: args.groupId ?? null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  await db.insert(schema.agentStatus).values({
    agentId: args.id,
    online: false,
    updatedAtMs: nowMs,
  });
  await db.insert(schema.agentBilling).values({
    agentId: args.id,
    quotaBytes: 1_000_000,
    mode: "sum",
    resetDay: 1,
    updatedAtMs: nowMs,
  });
}

describe("AgentRegistry", () => {
  let db: DbClient;
  let sqlite: Database;
  let registry: AgentRegistry;

  beforeEach(async () => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
    registry = new AgentRegistry(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  test("load() populates entries from existing rows", async () => {
    await seedAgent(db, { id: "a1", name: "alpha", isPublic: true, displayOrder: 0 });
    await seedAgent(db, { id: "a2", name: "beta", isPublic: false, displayOrder: 1 });
    await registry.load();

    expect(registry.size()).toBe(2);
    expect(registry.has("a1")).toBe(true);
    expect(registry.has("a2")).toBe(true);

    const publics = registry.listPublicSummaries();
    expect(publics.map((a) => a.id)).toEqual(["a1"]);

    const all = registry.listSummaries();
    expect(all.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  test("insert() adds an entry without DB write", async () => {
    await registry.load();
    const nowMs = Date.now();

    registry.insert({
      id: "new",
      name: "new agent",
      isPublic: true,
      displayOrder: 0,
      groupId: null,
      groupName: null,
      tags: [],
      note: null,
      billingConfig: { quotaBytes: 0, mode: "sum", resetDay: 1 },
      pricing: null,
      nowMs,
    });

    expect(registry.size()).toBe(1);
    const summary = registry.getSummary("new");
    expect(summary?.name).toBe("new agent");
    expect(summary?.billing.rxBytes).toBe(0);
    expect(summary?.billing.usedBytes).toBe(0);
  });

  test("applyHello() flips online=true and records host/os/arch/inventory", async () => {
    await seedAgent(db, { id: "a1", name: "alpha" });
    await registry.load();

    registry.applyHello("a1", {
      tsMs: 2_000,
      host: "host-1",
      os: "linux",
      arch: "x86_64",
      agentVersion: "1.0.0",
      capabilities: { ws: true },
      inventory: { cpu_brand: "AMD", cpu_count: 16, gpus: [] },
      ipV4: "10.0.0.1",
      ipV6: null,
    });

    const detail = registry.getAdminDetail("a1");
    expect(detail?.status.online).toBe(true);
    expect(detail?.status.lastSeenAtMs).toBe(2_000);
    expect(detail?.system.host).toBe("host-1");
    expect(detail?.system.os).toBe("linux");
    expect(detail?.system.capabilities).toEqual({ ws: true });
    expect(detail?.inventory?.cpu_brand).toBe("AMD");
    expect(detail?.inventory?.cpu_count).toBe(16);
  });

  function applyTelemetryFull(
    id: string,
    apply: Parameters<typeof registry.applyTelemetryTraffic>[1],
  ) {
    registry.applyTelemetryTraffic(id, apply);
    registry.applyTelemetryLatest(id, apply);
  }

  test("connected-path (Traffic+Latest) increments counters and sets latest", async () => {
    await seedAgent(db, { id: "a1", name: "alpha" });
    await registry.load();

    const baseArgs = {
      agentId: "a1",
      recvTsMs: Date.now(),
      seq: 5,
      uptimeSec: 123,
      rxBytesTotal: 1024,
      txBytesTotal: 2048,
      latestTelemetryPack: Buffer.alloc(0),
      numericMetrics: {},
    };

    applyTelemetryFull("a1", {
      args: baseArgs,
      result: { numericMetrics: {}, deltaRx: 1024, deltaTx: 2048 },
    });

    const s = registry.getSummary("a1");
    expect(s?.status.online).toBe(true);
    expect(s?.latest?.seq).toBe(5);
    expect(s?.latest?.uptimeSec).toBe(123);
    expect(s?.billing.rxBytes).toBe(1024);
    expect(s?.billing.txBytes).toBe(2048);
    expect(s?.billing.usedBytes).toBe(1024 + 2048);

    applyTelemetryFull("a1", {
      args: { ...baseArgs, seq: 6, uptimeSec: 124, recvTsMs: baseArgs.recvTsMs + 1000 },
      result: { numericMetrics: {}, deltaRx: 500, deltaTx: 100 },
    });
    const s2 = registry.getSummary("a1");
    expect(s2?.billing.rxBytes).toBe(1524);
    expect(s2?.billing.txBytes).toBe(2148);
    expect(s2?.latest?.seq).toBe(6);
    expect(s2?.latest?.uptimeSec).toBe(124);
  });

  test("applyTelemetryLatest() reads uptime from the dedicated arg, not numericMetrics['up_s']", async () => {
    await seedAgent(db, { id: "a1", name: "alpha" });
    await registry.load();

    applyTelemetryFull("a1", {
      args: {
        agentId: "a1",
        recvTsMs: Date.now(),
        seq: 1,
        uptimeSec: 42,
        rxBytesTotal: 0,
        txBytesTotal: 0,
        latestTelemetryPack: Buffer.alloc(0),
        numericMetrics: {}, // intentionally empty — up_s NOT in m
      },
      result: { numericMetrics: {}, deltaRx: 0, deltaTx: 0 },
    });
    expect(registry.getSummary("a1")?.latest?.uptimeSec).toBe(42);
  });

  test("applyTelemetryLatest() preserves uptimeSec=null when agent omits up_s", async () => {
    await seedAgent(db, { id: "a1", name: "alpha" });
    await registry.load();

    applyTelemetryFull("a1", {
      args: {
        agentId: "a1",
        recvTsMs: Date.now(),
        seq: 1,
        uptimeSec: null,
        rxBytesTotal: 0,
        txBytesTotal: 0,
        latestTelemetryPack: Buffer.alloc(0),
        numericMetrics: {},
      },
      result: { numericMetrics: {}, deltaRx: 0, deltaTx: 0 },
    });
    expect(registry.getSummary("a1")?.latest?.uptimeSec).toBeNull();
  });

  test("applyTelemetryTraffic() resets counters across period rollover", async () => {
    await seedAgent(db, { id: "a1", name: "alpha" });
    await registry.load();

    const beforeReset = Date.UTC(2026, 0, 31, 12, 0, 0); // Jan 31, resetDay=1
    const afterReset = Date.UTC(2026, 1, 1, 12, 0, 0); // Feb 1

    applyTelemetryFull("a1", {
      args: {
        agentId: "a1",
        recvTsMs: beforeReset,
        seq: 1,
        uptimeSec: 1,
        rxBytesTotal: 1000,
        txBytesTotal: 1000,
        latestTelemetryPack: Buffer.alloc(0),
        numericMetrics: {},
      },
      result: { numericMetrics: {}, deltaRx: 1000, deltaTx: 1000 },
    });
    expect(registry.getSummary("a1", beforeReset)?.billing.rxBytes).toBe(1000);

    applyTelemetryFull("a1", {
      args: {
        agentId: "a1",
        recvTsMs: afterReset,
        seq: 2,
        uptimeSec: 2,
        rxBytesTotal: 2000,
        txBytesTotal: 2000,
        latestTelemetryPack: Buffer.alloc(0),
        numericMetrics: {},
      },
      result: { numericMetrics: {}, deltaRx: 500, deltaTx: 500 },
    });
    const s = registry.getSummary("a1", afterReset);
    expect(s?.billing.rxBytes).toBe(500);
    expect(s?.billing.txBytes).toBe(500);
  });

  test("syncPricingFromDb() mirrors the DB pricing row into the registry", async () => {
    await seedAgent(db, { id: "a1", name: "alpha" });
    await registry.load();

    // No pricing row in DB → syncing produces null.
    expect(await registry.syncPricingFromDb("a1")).toBe(true);
    expect(registry.getSummary("a1")?.pricing).toBeNull();

    const nowMs = Date.now();
    await db.insert(schema.agentPricing).values({
      agentId: "a1",
      currency: "USD",
      cycle: "monthly",
      amountUnit: 500,
      expiresAtMs: 8000,
      updatedAtMs: nowMs,
    });

    expect(await registry.syncPricingFromDb("a1")).toBe(true);
    const after = registry.getSummary("a1")?.pricing;
    expect(after?.expiresAtMs).toBe(8000);
    expect(after?.currency).toBe("USD");
    expect(after?.cycle).toBe("monthly");
    expect(after?.amountUnit).toBe(500);
  });

  test("syncPricingFromDb() is a no-op for unknown agents", async () => {
    await registry.load();
    expect(await registry.syncPricingFromDb("nope")).toBe(false);
  });

  test("syncPricingFromDb() serializes with concurrent patch() — admin PATCH wins the final state", async () => {
    // Regression: previously the renewal worker wrote a stale expiresAtMs
    // into the registry after an admin PATCH committed, leaving the UI on a
    // "just-expired" value until another PATCH or a restart.
    await seedAgent(db, { id: "a1", name: "alpha" });
    await db.insert(schema.agentPricing).values({
      agentId: "a1",
      currency: "USD",
      cycle: "monthly",
      amountUnit: 500,
      expiresAtMs: 1_000,
      updatedAtMs: Date.now(),
    });
    await registry.load();
    expect(registry.getSummary("a1")?.pricing?.expiresAtMs).toBe(1_000);

    // Start a sync and a PATCH concurrently. The patch lock guarantees they
    // apply to the registry one-at-a-time, and syncPricingFromDb always
    // mirrors whatever's in DB *at lock acquisition time*.
    const [, patchResult] = await Promise.all([
      registry.syncPricingFromDb("a1"),
      (async () => {
        // Admin PATCH: changes DB *and* registry under the same lock.
        await db
          .update(schema.agentPricing)
          .set({ expiresAtMs: 9_999, updatedAtMs: Date.now() })
          .where(eq(schema.agentPricing.agentId, "a1"));
        await registry.patch("a1", {
          pricing: { currency: "USD", cycle: "monthly", amountUnit: 500, expiresAtMs: 9_999 },
        });
        return registry.getSummary("a1")?.pricing?.expiresAtMs;
      })(),
    ]);

    // After both tasks settle, registry must match whatever is in DB.
    const dbRows = await db
      .select({ expiresAtMs: schema.agentPricing.expiresAtMs })
      .from(schema.agentPricing)
      .where(eq(schema.agentPricing.agentId, "a1"));
    const registryPricing = registry.getSummary("a1")?.pricing;
    expect(registryPricing?.expiresAtMs).toBe(dbRows[0]!.expiresAtMs);
    // And the admin PATCH's intended value is reflected regardless of which
    // task raced ahead.
    expect(patchResult).toBe(9_999);
  });

  test("patch() updates fields and defers period refresh when resetDay changes", async () => {
    await seedAgent(db, { id: "a1", name: "alpha" });
    await registry.load();

    await registry.patch("a1", { name: "renamed", isPublic: false, note: "memo" });
    const after = registry.getAdminDetail("a1");
    expect(after?.name).toBe("renamed");
    expect(after?.isPublic).toBe(false);
    expect(after?.note).toBe("memo");

    // pricing toggling
    await registry.patch("a1", {
      pricing: { currency: "USD", cycle: "monthly", amountUnit: 500, expiresAtMs: null },
    });
    expect(registry.getAdminDetail("a1")?.pricing?.amountUnit).toBe(500);
    await registry.patch("a1", { pricing: "delete" });
    expect(registry.getAdminDetail("a1")?.pricing).toBeNull();

    // resetDay change should NOT refresh inline (that would race with
    // applyTelemetryTraffic). Instead the refresh waits for the next
    // FlushBuffer tick, which calls drainPendingPeriodRefreshes.
    await registry.patch("a1", {
      billingConfig: { quotaBytes: 1_000_000, mode: "sum", resetDay: 15 },
    });
    // No explicit way to observe the pending flag from outside, but we can
    // seed trafficDay then drain and observe that the counters got synced.
    const todayDay = Number(new Date(Date.now()).toISOString().slice(0, 10).replace(/-/g, ""));
    await db.insert(schema.trafficDay).values({
      agentId: "a1",
      dayYyyyMmDd: todayDay,
      rxBytes: 4_242,
      txBytes: 5_353,
      updatedAtMs: Date.now(),
    });

    await registry.drainPendingPeriodRefreshes();

    const billing = registry.getSummary("a1")?.billing;
    expect(billing?.rxBytes).toBe(4_242);
    expect(billing?.txBytes).toBe(5_353);
  });

  test("drainPendingPeriodRefreshes() is a no-op when nothing is pending", async () => {
    await seedAgent(db, { id: "a1", name: "alpha" });
    await registry.load();
    // Seed trafficDay — if the drainer ran anyway, counters would change.
    const todayDay = Number(new Date(Date.now()).toISOString().slice(0, 10).replace(/-/g, ""));
    await db.insert(schema.trafficDay).values({
      agentId: "a1",
      dayYyyyMmDd: todayDay,
      rxBytes: 9_999,
      txBytes: 9_999,
      updatedAtMs: Date.now(),
    });

    await registry.drainPendingPeriodRefreshes();

    const billing = registry.getSummary("a1")?.billing;
    expect(billing?.rxBytes).toBe(0);
    expect(billing?.txBytes).toBe(0);
  });

  test("markOffline() flips online=false", async () => {
    await seedAgent(db, { id: "a1", name: "alpha" });
    await registry.load();
    registry.applyHello("a1", {
      tsMs: 1000,
      host: null,
      os: null,
      arch: null,
      agentVersion: null,
      capabilities: null,
      inventory: undefined,
      ipV4: null,
      ipV6: null,
    });
    expect(registry.getSummary("a1")?.status.online).toBe(true);

    registry.markOffline("a1", 2000);
    const s = registry.getSummary("a1");
    expect(s?.status.online).toBe(false);
    expect(s?.status.lastSeenAtMs).toBe(2000);
  });

  test("remove() deletes the entry", async () => {
    await seedAgent(db, { id: "a1", name: "alpha" });
    await registry.load();
    expect(registry.has("a1")).toBe(true);
    registry.remove("a1");
    expect(registry.has("a1")).toBe(false);
    expect(registry.getSummary("a1")).toBeNull();
  });

  test("getPublicDetail() hides non-public agents", async () => {
    await seedAgent(db, { id: "a1", name: "alpha", isPublic: false });
    await registry.load();
    expect(registry.getPublicDetail("a1")).toBeNull();
    expect(registry.getDetail("a1")?.id).toBe("a1");
  });

  test("reorder() updates displayOrder in-place", async () => {
    await seedAgent(db, { id: "a1", name: "alpha", displayOrder: 0 });
    await seedAgent(db, { id: "a2", name: "beta", displayOrder: 1 });
    await seedAgent(db, { id: "a3", name: "gamma", displayOrder: 2 });
    await registry.load();

    registry.reorder(["a3", "a1", "a2"]);
    const ids = registry.listSummaries().map((a) => a.id);
    expect(ids).toEqual(["a3", "a1", "a2"]);
  });

  test("listAdminSummaries() applies filters", async () => {
    await seedAgent(db, { id: "a1", name: "alpha", isPublic: true });
    await seedAgent(db, { id: "a2", name: "beta", isPublic: false });
    await registry.load();

    expect(registry.listAdminSummaries({ isPublic: true }).map((a) => a.id)).toEqual(["a1"]);
    expect(registry.listAdminSummaries({ q: "bet" }).map((a) => a.id)).toEqual(["a2"]);
    expect(registry.listAdminSummaries({ online: true })).toHaveLength(0);
  });

  describe("ensureAgent()", () => {
    test("lazy-loads an agent that was inserted after load()", async () => {
      // Simulate: server boot → registry.load() → CLI `create-agent` writes
      // rows directly to the DB → agent dials in. Without ensureAgent the
      // registry would never see it.
      await registry.load();
      expect(registry.size()).toBe(0);

      await seedAgent(db, { id: "cli-agent", name: "from-cli" });

      const loaded = await registry.ensureAgent("cli-agent");
      expect(loaded).toBe(true);
      expect(registry.has("cli-agent")).toBe(true);

      // Subsequent applyHello now takes effect instead of silently no-op-ing.
      registry.applyHello("cli-agent", {
        tsMs: 1000,
        host: "cli-host",
        os: "linux",
        arch: "x86_64",
        agentVersion: "1.0.0",
        capabilities: null,
        inventory: undefined,
        ipV4: "10.0.0.5",
        ipV6: null,
      });
      const summary = registry.getSummary("cli-agent");
      expect(summary?.status.online).toBe(true);
      expect(summary?.system.os).toBe("linux");
    });

    test("returns false when the agent does not exist in the DB either", async () => {
      await registry.load();
      const loaded = await registry.ensureAgent("ghost");
      expect(loaded).toBe(false);
      expect(registry.has("ghost")).toBe(false);
    });

    test("does not clobber in-memory state when the agent is already loaded", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();

      // Mutate the registry entry so we can detect if ensureAgent re-reads it.
      registry.applyHello("a1", {
        tsMs: 1000,
        host: "live-host",
        os: null,
        arch: null,
        agentVersion: null,
        capabilities: null,
        inventory: undefined,
        ipV4: null,
        ipV6: null,
      });

      const loaded = await registry.ensureAgent("a1");
      expect(loaded).toBe(true);
      // Fast path: the in-memory hello state is preserved.
      expect(registry.getAdminDetail("a1")?.system.host).toBe("live-host");
    });

    test("concurrent ensureAgent calls converge to a single consistent entry", async () => {
      await registry.load();
      await seedAgent(db, { id: "a1", name: "alpha" });

      const [r1, r2, r3] = await Promise.all([
        registry.ensureAgent("a1"),
        registry.ensureAgent("a1"),
        registry.ensureAgent("a1"),
      ]);
      expect([r1, r2, r3]).toEqual([true, true, true]);
      expect(registry.size()).toBe(1);
      expect(registry.getSummary("a1")?.name).toBe("alpha");
    });

    test("does not resurrect an agent that was deleted during its DB read", async () => {
      // Regression: previously ensureAgent read the agent row, awaited, then
      // inserted it into `entries` even if an admin DELETE had removed both
      // the DB row and the registry entry in the meantime. Detail endpoints
      // would then return 200 for a gone agent until `syncFromDb` cleaned up.
      //
      // Now ensureAgent takes the same per-agent patch lock that DELETE uses,
      // and verifies the row still exists right before the final set.
      await seedAgent(db, { id: "doomed", name: "doomed" });
      await registry.load();
      // Pre-warm: clear the cached entry so ensureAgent takes the slow path
      // (lock → DB read → set). If we left the entry in place the fast-path
      // early return would skip the interesting logic.
      registry.remove("doomed");

      // Race: ensureAgent starts, DELETE then runs under the same lock.
      // The lock forces DELETE to wait for ensureAgent, OR ensureAgent to
      // wait for DELETE. Either way the final registry state must match DB.
      const ensurePromise = registry.ensureAgent("doomed");
      const deletePromise = registry.runUnderPatchLock("doomed", async () => {
        await db.delete(schema.agent).where(eq(schema.agent.id, "doomed"));
        registry.remove("doomed");
      });

      const [ensureResult] = await Promise.all([ensurePromise, deletePromise]);

      // DB is the ground truth: the row is gone.
      const remaining = await db
        .select({ id: schema.agent.id })
        .from(schema.agent)
        .where(eq(schema.agent.id, "doomed"));
      expect(remaining).toHaveLength(0);

      // Registry must agree — no ghost entry.
      expect(registry.has("doomed")).toBe(false);

      // If ensureAgent happened to acquire the lock first, it returned true
      // (successfully cached), then DELETE cleared it. If DELETE went first,
      // ensureAgent re-checked under the lock and returned false. Either is
      // acceptable; the post-condition (no ghost) is what matters.
      expect(typeof ensureResult).toBe("boolean");
    });
  });

  describe("applyTelemetry split (Traffic vs Latest)", () => {
    test("applyTelemetryTraffic() updates period counters without touching online/latest", async () => {
      // Regression: flush for a disconnected agent must still mirror
      // trafficDay into registry counters, otherwise billing drifts below DB.
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();

      // Use recent timestamps so buildBilling's current-period comparison
      // matches the period the Traffic apply recorded against.
      const offlineAtMs = Date.now();
      const sampleAtMs = offlineAtMs + 500;
      registry.markOffline("a1", offlineAtMs); // simulate close() just fired

      const statusBefore = registry.getSummary("a1", sampleAtMs)?.status;
      expect(statusBefore?.online).toBe(false);
      expect(statusBefore?.lastSeenAtMs).toBe(offlineAtMs);
      expect(registry.getSummary("a1", sampleAtMs)?.latest).toBeNull();

      registry.applyTelemetryTraffic("a1", {
        args: {
          agentId: "a1",
          recvTsMs: sampleAtMs,
          seq: 9,
          uptimeSec: 42,
          rxBytesTotal: 500,
          txBytesTotal: 500,
          latestTelemetryPack: Buffer.alloc(0),
          numericMetrics: {},
        },
        result: { numericMetrics: {}, deltaRx: 500, deltaTx: 500 },
      });

      const s = registry.getSummary("a1", sampleAtMs);
      // Traffic moved forward.
      expect(s?.billing.rxBytes).toBe(500);
      expect(s?.billing.txBytes).toBe(500);
      // Status did NOT get revived by this stale sample.
      expect(s?.status.online).toBe(false);
      expect(s?.status.lastSeenAtMs).toBe(offlineAtMs);
      // latest also untouched.
      expect(s?.latest).toBeNull();
    });

    test("applyTelemetryLatest() updates online/latest without double-counting traffic", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();

      const sampleAtMs = Date.now();
      registry.applyTelemetryLatest("a1", {
        args: {
          agentId: "a1",
          recvTsMs: sampleAtMs,
          seq: 3,
          uptimeSec: 99,
          rxBytesTotal: 1000,
          txBytesTotal: 2000,
          latestTelemetryPack: Buffer.alloc(0),
          numericMetrics: {},
        },
        result: { numericMetrics: {}, deltaRx: 111, deltaTx: 222 },
      });

      const s = registry.getSummary("a1", sampleAtMs);
      expect(s?.status.online).toBe(true);
      expect(s?.status.lastSeenAtMs).toBe(sampleAtMs);
      expect(s?.latest?.seq).toBe(3);
      expect(s?.latest?.uptimeSec).toBe(99);
      // Latest does NOT touch period counters (Traffic owns that).
      expect(s?.billing.rxBytes).toBe(0);
      expect(s?.billing.txBytes).toBe(0);
    });
  });

  describe("syncFromDb()", () => {
    test("adds rows present in DB but missing from the registry", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();
      expect(registry.size()).toBe(1);

      // Simulate CLI `create-agent` writing rows directly while server runs.
      await seedAgent(db, { id: "cli-agent", name: "from-cli" });
      expect(registry.size()).toBe(1);

      await registry.syncFromDb();
      expect(registry.size()).toBe(2);
      expect(registry.has("cli-agent")).toBe(true);
    });

    test("drops entries whose DB row has disappeared", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await seedAgent(db, { id: "a2", name: "beta" });
      await registry.load();
      expect(registry.size()).toBe(2);

      await db.delete(schema.agent).where(eq(schema.agent.id, "a2"));
      await registry.syncFromDb();

      expect(registry.has("a1")).toBe(true);
      expect(registry.has("a2")).toBe(false);
    });

    test("is a no-op when the DB and registry already agree", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();

      registry.applyHello("a1", {
        tsMs: 1000,
        host: "live-host",
        os: null,
        arch: null,
        agentVersion: null,
        capabilities: null,
        inventory: undefined,
        ipV4: null,
        ipV6: null,
      });

      await registry.syncFromDb();
      // Fast path: in-memory state was not clobbered by a re-read.
      expect(registry.getAdminDetail("a1")?.system.host).toBe("live-host");
    });
  });

  describe("syncFromDbIfStale()", () => {
    // Intercept the underlying sync to count how many times it actually runs,
    // without touching drizzle internals. The gate is the only thing under
    // test here — `syncFromDb`'s own behavior is already covered elsewhere.
    function spyOnSync(target: AgentRegistry): { calls: () => number } {
      const slot = target as unknown as { syncFromDb: () => Promise<void> };
      const original = slot.syncFromDb.bind(target);
      let n = 0;
      slot.syncFromDb = async () => {
        n++;
        return original();
      };
      return { calls: () => n };
    }

    test("skips the DB scan when a previous sync is within the TTL window", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();
      const spy = spyOnSync(registry);

      await registry.syncFromDbIfStale(60_000);
      expect(spy.calls()).toBe(1);
      // Second call well within the TTL — no additional scan.
      await registry.syncFromDbIfStale(60_000);
      expect(spy.calls()).toBe(1);
    });

    test("re-scans when ttlMs=0 forces every caller past the gate", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();
      const spy = spyOnSync(registry);

      await registry.syncFromDbIfStale(0);
      await registry.syncFromDbIfStale(0);
      expect(spy.calls()).toBe(2);
    });

    test("concurrent callers coalesce onto a single in-flight scan", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();
      const spy = spyOnSync(registry);

      await Promise.all([
        registry.syncFromDbIfStale(60_000),
        registry.syncFromDbIfStale(60_000),
        registry.syncFromDbIfStale(60_000),
      ]);
      expect(spy.calls()).toBe(1);
    });

    test("a failed sync does not cache the TTL — the next caller retries", async () => {
      await registry.load();
      const slot = registry as unknown as { syncFromDb: () => Promise<void> };
      const original = slot.syncFromDb.bind(registry);
      let attempts = 0;
      slot.syncFromDb = async () => {
        attempts++;
        if (attempts === 1) throw new Error("boom");
        return original();
      };

      await expect(registry.syncFromDbIfStale(60_000)).rejects.toThrow("boom");
      // Immediately retry — TTL was not advanced on the failing path.
      await registry.syncFromDbIfStale(60_000);
      expect(attempts).toBe(2);
    });
  });

  describe("admin wire shape", () => {
    test("listAdminSummaries never includes inventory (bandwidth contract)", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();
      registry.applyHello("a1", {
        tsMs: 1000,
        host: "h",
        os: "linux",
        arch: "x86_64",
        agentVersion: "1.0",
        capabilities: null,
        inventory: { cpu_brand: "AMD", cpu_count: 8, gpus: [] },
        ipV4: null,
        ipV6: null,
      });

      const summaries = registry.listAdminSummaries();
      expect(summaries).toHaveLength(1);
      expect("inventory" in summaries[0]!).toBe(false);
    });

    test("getAdminDetail includes inventory", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();
      registry.applyHello("a1", {
        tsMs: 1000,
        host: "h",
        os: "linux",
        arch: "x86_64",
        agentVersion: "1.0",
        capabilities: null,
        inventory: { cpu_brand: "AMD", cpu_count: 8, gpus: [] },
        ipV4: null,
        ipV6: null,
      });

      const detail = registry.getAdminDetail("a1");
      expect(detail?.inventory?.cpu_brand).toBe("AMD");
      expect(detail?.inventory?.cpu_count).toBe(8);
    });
  });

  describe("patchWithDb()", () => {
    test("applies registry changes BEFORE the dbTask runs", async () => {
      // Regression: if DB commits first and registry later, a concurrent
      // anonymous read on a just-privatized agent would still see it as
      // public. patchWithDb must make the in-memory state match-or-lead
      // the DB state as soon as the dbTask begins.
      await seedAgent(db, { id: "a1", name: "alpha", isPublic: true });
      await registry.load();
      expect(registry.getSummary("a1")?.isPublic).toBe(true);

      let observedIsPublicDuringDb: boolean | undefined;
      const applied = await registry.patchWithDb("a1", { isPublic: false }, async () => {
        // At this point the registry has already been updated.
        observedIsPublicDuringDb = registry.getSummary("a1")?.isPublic;
        await db.update(schema.agent).set({ isPublic: false }).where(eq(schema.agent.id, "a1"));
      });

      expect(applied).toBe(true);
      expect(observedIsPublicDuringDb).toBe(false);
      expect(registry.getSummary("a1")?.isPublic).toBe(false);
    });

    test("reverts the registry when dbTask throws", async () => {
      await seedAgent(db, { id: "a1", name: "alpha", isPublic: true });
      await registry.load();

      await expect(
        registry.patchWithDb("a1", { isPublic: false, name: "renamed" }, async () => {
          // DB write fails midway — registry must roll back.
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const s = registry.getSummary("a1");
      expect(s?.isPublic).toBe(true);
      expect(s?.name).toBe("alpha");
    });

    test("returns false when the agent is no longer in the registry", async () => {
      // e.g. a concurrent DELETE removed the agent while we waited on the lock.
      await registry.load();
      const applied = await registry.patchWithDb("ghost", { isPublic: false }, async () => {
        throw new Error("should not run");
      });
      expect(applied).toBe(false);
    });

    test("applies dbTask-returned registry patch before releasing the patch lock", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();

      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      let secondObservedGroupId: string | null | undefined;
      const firstPatch = registry.patchWithDb("a1", {}, async () => {
        await firstMayCommit;
        return { groupId: "g-first", groupName: "first" };
      });
      const secondPatch = registry.patchWithDb("a1", {}, async () => {
        secondObservedGroupId = registry.getAdminDetail("a1")?.groupId;
        return { groupId: "g-second", groupName: "second" };
      });

      releaseFirst();
      await Promise.all([firstPatch, secondPatch]);

      expect(secondObservedGroupId).toBe("g-first");
      expect(registry.getAdminDetail("a1")?.groupId).toBe("g-second");
      expect(registry.getAdminDetail("a1")?.group).toBe("second");
    });
  });

  describe("drainPendingPeriodRefreshes() patch lock interactions", () => {
    test("does not clobber a pending flag set by a PATCH that raced during the refresh", async () => {
      // Regression: drain's `pendingPeriodRefresh = false` used to overwrite
      // the flag a concurrent PATCH had just set for a second resetDay
      // change. That left the counters stuck at the previous resetDay's
      // period while `billingConfig` advertised the newest one.
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();

      // Seed trafficDay for TODAY so whichever resetDay wins has a sum to mirror.
      const todayDay = Number(new Date().toISOString().slice(0, 10).replace(/-/g, ""));
      await db.insert(schema.trafficDay).values({
        agentId: "a1",
        dayYyyyMmDd: todayDay,
        rxBytes: 111,
        txBytes: 222,
        updatedAtMs: Date.now(),
      });

      // First PATCH: resetDay 1 → 15. Flag goes to true.
      await registry.patch("a1", {
        billingConfig: { quotaBytes: 0, mode: "sum", resetDay: 15 },
      });

      // Second PATCH runs DURING the drain. Under the lock, it can only
      // land BEFORE drain acquires or AFTER drain releases. Either way
      // the flag must end up true (set by the second PATCH) unless drain
      // observed that same patch too.
      const drainPromise = registry.drainPendingPeriodRefreshes();
      const secondPatchPromise = registry.patch("a1", {
        billingConfig: { quotaBytes: 0, mode: "sum", resetDay: 20 },
      });
      await Promise.all([drainPromise, secondPatchPromise]);

      // Final state: billingConfig resetDay=20. Either
      //   (a) drain ran first (refresh w/ resetDay=15), then PATCH ran
      //       and set pendingPeriodRefresh=true for resetDay=20, or
      //   (b) PATCH ran first (pending already true for resetDay=20),
      //       then drain ran and refreshed w/ resetDay=20, clearing flag.
      // In (a) we'd need one more drain; in (b) we're already done. Either
      // way, after one more drain the final state converges.
      await registry.drainPendingPeriodRefreshes();

      const s = registry.getSummary("a1");
      expect(s?.billing.resetDay).toBe(20);
      // Counters reflect trafficDay under resetDay=20's period (which
      // includes today). Concrete sum = 111 rx + 222 tx.
      expect(s?.billing.rxBytes).toBe(111);
      expect(s?.billing.txBytes).toBe(222);
      // And no pending flag lingers.
      expect(registry.hasPendingPeriodRefreshes()).toBe(false);
    });

    test("re-checks pending flag under the lock so an already-drained agent is skipped", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();
      // Kick the flag true manually via a resetDay change.
      await registry.patch("a1", {
        billingConfig: { quotaBytes: 0, mode: "sum", resetDay: 15 },
      });
      expect(registry.hasPendingPeriodRefreshes()).toBe(true);

      await registry.drainPendingPeriodRefreshes();
      expect(registry.hasPendingPeriodRefreshes()).toBe(false);

      // Running drain again is a cheap no-op (no re-read of trafficDay).
      await registry.drainPendingPeriodRefreshes();
      expect(registry.hasPendingPeriodRefreshes()).toBe(false);
    });
  });

  describe("listForAlert()", () => {
    test("returns every entry sorted by displayOrder then name, with the expected shape", async () => {
      const nowMs = 1_700_000_000_000;
      await db.insert(schema.agentGroup).values({
        id: "g-prod",
        name: "prod",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
      await seedAgent(db, { id: "a1", name: "b-host", displayOrder: 1, groupId: "g-prod" });
      await seedAgent(db, { id: "a2", name: "a-host", displayOrder: 1, isPublic: false });
      await seedAgent(db, { id: "a3", name: "c-host", displayOrder: 0 });
      await registry.load();

      const views = registry.listForAlert(nowMs);
      // Public/private both included — alert rules apply regardless of visibility.
      expect(views.map((v) => v.id)).toEqual(["a3", "a2", "a1"]);

      const a1 = views.find((v) => v.id === "a1")!;
      expect(a1.name).toBe("b-host");
      expect(a1.groupId).toBe("g-prod");
      expect(a1.groupName).toBe("prod");
      expect(a1.lastSeenAtMs).toBeNull();
      expect(a1.metrics).toEqual({});
      expect(a1.billing.quotaBytes).toBe(1_000_000);
      expect(a1.billing.mode).toBe("sum");
      expect(a1.pricing).toBeNull();

      const a2 = views.find((v) => v.id === "a2")!;
      expect(a2.groupId).toBeNull();
      expect(a2.groupName).toBeNull();
    });

    test("metrics keeps only finite numbers — NaN, Infinity, and strings are filtered out", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();

      const recvTsMs = 1_700_000_000_000;
      registry.applyTelemetryLatest("a1", {
        args: {
          agentId: "a1",
          recvTsMs,
          seq: 1,
          uptimeSec: 10,
          rxBytesTotal: 0,
          txBytesTotal: 0,
          latestTelemetryPack: Buffer.alloc(0),
          numericMetrics: {},
        },
        // Ingest normally guarantees all-number maps, but pickNumericMetrics
        // defends regardless. Cast through unknown to inject the garbage
        // values the filter is meant to drop.
        result: {
          deltaRx: 0,
          deltaTx: 0,
          numericMetrics: {
            "cpu.usage_pct": 42.5,
            "mem.used_pct": Number.NaN,
            "disk.used_pct": Number.POSITIVE_INFINITY,
            "misc.label": "oops",
          } as unknown as Record<string, number>,
        },
      });

      const view = registry.listForAlert(recvTsMs).find((v) => v.id === "a1");
      expect(view?.metrics).toEqual({ "cpu.usage_pct": 42.5 });
    });

    test("pricing is null when no agent_pricing row exists", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();

      const view = registry.listForAlert().find((v) => v.id === "a1");
      expect(view?.pricing).toBeNull();
    });

    test("pricing is null when expiresAtMs is null — the agent_expiring rule has nothing to measure", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await db.insert(schema.agentPricing).values({
        agentId: "a1",
        currency: "USD",
        cycle: "monthly",
        amountUnit: 500,
        expiresAtMs: null,
        updatedAtMs: 1_700_000_000_000,
      });
      await registry.load();

      const view = registry.listForAlert().find((v) => v.id === "a1");
      expect(view?.pricing).toBeNull();
    });

    test("pricing exposes only expiresAtMs and cycle (currency/amountUnit stay internal)", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await db.insert(schema.agentPricing).values({
        agentId: "a1",
        currency: "USD",
        cycle: "yearly",
        amountUnit: 12_000,
        expiresAtMs: 9_000_000_000_000,
        updatedAtMs: 1_700_000_000_000,
      });
      await registry.load();

      const view = registry.listForAlert().find((v) => v.id === "a1");
      expect(view?.pricing).toEqual({ expiresAtMs: 9_000_000_000_000, cycle: "yearly" });
    });

    test("billing reflects the in-memory period counters (same path as public/admin summaries)", async () => {
      await seedAgent(db, { id: "a1", name: "alpha" });
      await registry.load();

      // resetDay=1 from seedAgent, so Apr 15 lands in the current period.
      const recvTsMs = Date.UTC(2026, 3, 15, 12, 0, 0);
      applyTelemetryFull("a1", {
        args: {
          agentId: "a1",
          recvTsMs,
          seq: 1,
          uptimeSec: 1,
          rxBytesTotal: 3000,
          txBytesTotal: 4000,
          latestTelemetryPack: Buffer.alloc(0),
          numericMetrics: {},
        },
        result: { numericMetrics: {}, deltaRx: 3000, deltaTx: 4000 },
      });

      const view = registry.listForAlert(recvTsMs).find((v) => v.id === "a1");
      expect(view?.billing.rxBytes).toBe(3000);
      expect(view?.billing.txBytes).toBe(4000);
      expect(view?.billing.usedBytes).toBe(7000);
      expect(view?.lastSeenAtMs).toBe(recvTsMs);
    });
  });
});
