import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { AgentRegistry } from "../agents/registry";
import type { DbClient } from "../db/client";
import * as schema from "../db/schema";
import { markAgentOffline } from "../ingest/status";
import type { TelemetryIngestArgs } from "../ingest/telemetry";
import { getMigrationsFolder } from "../paths";
import { FlushBuffer } from "./flush-buffer";

function createTestDb(): { db: DbClient; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema }) as DbClient;
  migrate(db, { migrationsFolder: getMigrationsFolder() });
  return { db, sqlite };
}

// Use a "now"-ish epoch so the registry's read-path period check (which uses
// Date.now by default) agrees with the period the flushed sample was written
// against. Otherwise buildBilling would surface 0/0 for this period.
const NOW_MS = Date.now();

async function seedAgent(db: DbClient, id: string) {
  await db.insert(schema.agent).values({
    id,
    tokenHash: `hash-${id}`,
    name: id,
    isPublic: true,
    displayOrder: 0,
    tagsJson: "[]",
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
  });
  await db.insert(schema.agentStatus).values({
    agentId: id,
    online: false,
    updatedAtMs: NOW_MS,
  });
  await db.insert(schema.agentBilling).values({
    agentId: id,
    quotaBytes: 0,
    mode: "sum",
    resetDay: 1,
    updatedAtMs: NOW_MS,
  });
  // Prime trafficCounter so the first test sample already produces a delta.
  await db.insert(schema.trafficCounter).values({
    agentId: id,
    lastTsMs: NOW_MS - 1000,
    lastRxBytesTotal: 0,
    lastTxBytesTotal: 0,
    updatedAtMs: NOW_MS - 1000,
  });
}

function makeTelemetry(agentId: string, rx: number, tx: number): TelemetryIngestArgs {
  return {
    agentId,
    recvTsMs: NOW_MS + 10_000,
    seq: 1,
    uptimeSec: 60,
    rxBytesTotal: rx,
    txBytesTotal: tx,
    latestTelemetryPack: Buffer.from([0x01]),
    numericMetrics: {},
  };
}

describe("FlushBuffer integration: connected vs disconnected at flush time", () => {
  let db: DbClient;
  let sqlite: Database;
  let registry: AgentRegistry;

  beforeEach(async () => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
    registry = new AgentRegistry(db);
  });
  afterEach(() => sqlite.close());

  test("agent disconnected after enqueue still flushes traffic to DB AND registry", async () => {
    await seedAgent(db, "a1");
    await registry.load();

    // Flip the "connected" view to false before flush runs — simulating the
    // race the review flagged: sample buffered while connected, agent closes,
    // doFlush sees isAgentConnected=false.
    let connected = true;
    const isAgentConnected = (_id: string) => connected;

    const buffer = new FlushBuffer(
      {
        db,
        registry,
        asnLookup: null,
        isAgentConnected,
        onRouteChanges: () => {},
      },
      { maxProbeEntries: 100, maxProbeBytes: 10_000, flushIntervalMs: 10_000 },
    );

    const offlineAtMs = NOW_MS + 5_000;
    buffer.enqueueTelemetry(makeTelemetry("a1", 1_500, 2_500));
    // Also reflect the disconnect in status (the real close() path does this).
    await db.transaction((tx) => markAgentOffline(tx, "a1", offlineAtMs));
    registry.markOffline("a1", offlineAtMs);
    connected = false;

    await buffer.stop();

    // DB: traffic persisted.
    const trafficDayRows = await db.select().from(schema.trafficDay);
    expect(trafficDayRows).toHaveLength(1);
    expect(trafficDayRows[0]!.rxBytes).toBe(1_500);
    expect(trafficDayRows[0]!.txBytes).toBe(2_500);

    // Registry: counters moved forward by exactly the same delta — no drift.
    const s = registry.getSummary("a1", NOW_MS + 20_000);
    expect(s?.billing.rxBytes).toBe(1_500);
    expect(s?.billing.txBytes).toBe(2_500);
    // Status NOT revived by the stale sample.
    expect(s?.status.online).toBe(false);
    expect(s?.status.lastSeenAtMs).toBe(offlineAtMs);
    // latest NOT overwritten (it was null; stays null).
    expect(s?.latest).toBeNull();

    // And agentStatus in DB is still offline.
    const statusRow = await db
      .select({ online: schema.agentStatus.online })
      .from(schema.agentStatus)
      .where(eq(schema.agentStatus.agentId, "a1"));
    expect(statusRow[0]?.online).toBe(false);
  });

  test("agent still connected at flush time updates traffic AND latest", async () => {
    await seedAgent(db, "a1");
    await registry.load();

    const buffer = new FlushBuffer(
      {
        db,
        registry,
        asnLookup: null,
        isAgentConnected: () => true,
        onRouteChanges: () => {},
      },
      { maxProbeEntries: 100, maxProbeBytes: 10_000, flushIntervalMs: 10_000 },
    );

    buffer.enqueueTelemetry(makeTelemetry("a1", 800, 1_200));
    await buffer.stop();

    const s = registry.getSummary("a1", NOW_MS + 20_000);
    expect(s?.billing.rxBytes).toBe(800);
    expect(s?.billing.txBytes).toBe(1_200);
    expect(s?.status.online).toBe(true);
    expect(s?.latest?.seq).toBe(1);
    expect(s?.latest?.uptimeSec).toBe(60);
  });

  test("quiesceAgent-style fence: no FK violation, sibling agents' data preserved", async () => {
    // Regression for Issue 3: previously, an agent DELETE that landed while
    // a flush was in flight could trip a SQLITE_CONSTRAINT_FOREIGNKEY on
    // trafficCounter/trafficDay (cascade deleted the parent row), rolling
    // back the whole batch and losing OTHER agents' data.
    //
    // Simulates the fence added by `ProbeDispatcher.quiesceAgent`:
    // `removeAgent` + `awaitInflight` BEFORE the DB delete tx.
    await seedAgent(db, "doomed");
    await seedAgent(db, "sibling");
    await registry.load();

    const buffer = new FlushBuffer(
      {
        db,
        registry,
        asnLookup: null,
        isAgentConnected: () => true,
        onRouteChanges: () => {},
      },
      { maxProbeEntries: 100, maxProbeBytes: 10_000, flushIntervalMs: 10_000 },
    );

    // Both agents have buffered telemetry when the admin hits DELETE.
    buffer.enqueueTelemetry(makeTelemetry("doomed", 100, 200));
    buffer.enqueueTelemetry(makeTelemetry("sibling", 300, 400));

    // Fence: drop doomed's entries and await any flush in flight. In this
    // test there's no in-flight flush yet, so it's essentially just
    // removeAgent — but awaitInflight is the contract we want to exercise.
    buffer.removeAgent("doomed");
    await buffer.awaitInflight();

    // Admin's DB tx: cascade-deletes doomed's FK rows.
    await db.delete(schema.agent).where(eq(schema.agent.id, "doomed"));

    // Now a flush fires. doomed is gone from both DB and buffer, so no FK
    // violation. sibling's data must land normally.
    await buffer.stop();

    const trafficDayRows = await db.select().from(schema.trafficDay);
    expect(trafficDayRows).toHaveLength(1);
    expect(trafficDayRows[0]!.agentId).toBe("sibling");
    expect(trafficDayRows[0]!.rxBytes).toBe(300);
    expect(trafficDayRows[0]!.txBytes).toBe(400);

    const siblingSummary = registry.getSummary("sibling", NOW_MS + 20_000);
    expect(siblingSummary?.billing.rxBytes).toBe(300);
    expect(siblingSummary?.billing.txBytes).toBe(400);
  });

  test("drainPendingPeriodRefreshes runs inside doFlush — no race with applyTelemetryTraffic", async () => {
    // Regression: a resetDay change used to `await refreshPeriodTotals`
    // inline inside patch(). During that await, a flush commit could
    // interleave: its applyTelemetryTraffic would add a delta to the
    // counters, which refreshPeriodTotals would then overwrite with a
    // stale sum — bytes silently lost until restart.
    //
    // Now patch() only marks `pendingPeriodRefresh`; the refresh actually
    // happens at the tail of doFlush, where the inflight guard ensures no
    // concurrent apply. After the full round-trip the registry must match
    // the DB sum exactly.
    await seedAgent(db, "a1");
    await registry.load();

    const buffer = new FlushBuffer(
      {
        db,
        registry,
        asnLookup: null,
        isAgentConnected: () => true,
        onRouteChanges: () => {},
      },
      { maxProbeEntries: 100, maxProbeBytes: 10_000, flushIntervalMs: 10_000 },
    );

    // Admin changes billing.resetDay concurrently: patch only flags pending,
    // it does NOT await a DB query here.
    const patchPromise = registry.patch("a1", {
      billingConfig: { quotaBytes: 0, mode: "sum", resetDay: 15 },
    });

    // While that's settling, telemetry shows up with a delta.
    buffer.enqueueTelemetry(makeTelemetry("a1", 777, 333));

    // Drive flush + drain to completion.
    await patchPromise;
    await buffer.stop();

    // What's in the DB is the ground truth.
    const trafficDayRows = await db.select().from(schema.trafficDay);
    const dbRx = trafficDayRows.reduce((sum, r) => sum + r.rxBytes, 0);
    const dbTx = trafficDayRows.reduce((sum, r) => sum + r.txBytes, 0);

    const summary = registry.getSummary("a1", NOW_MS + 20_000);
    // Registry counters exactly mirror DB — no drift from a lost-or-doubled
    // apply during the patch's await window.
    expect(summary?.billing.rxBytes).toBe(dbRx);
    expect(summary?.billing.txBytes).toBe(dbTx);
  });

  test("resetDay change on an idle agent still gets drained by the next flush tick", async () => {
    // Regression: previously `flush()` short-circuited on empty buffers, so
    // a pending period refresh on an offline / idle agent would sit forever.
    // Now `flush()` also runs when the registry reports a pending refresh,
    // letting the timer-driven drain fire within one interval even without
    // telemetry.
    await seedAgent(db, "idle");
    await registry.load();

    // Put some bytes in trafficDay for today under the NEW period window so
    // `refreshPeriodTotals` has something meaningful to mirror.
    const todayDay = Number(new Date(NOW_MS + 10_000).toISOString().slice(0, 10).replace(/-/g, ""));
    await db.insert(schema.trafficDay).values({
      agentId: "idle",
      dayYyyyMmDd: todayDay,
      rxBytes: 7_777,
      txBytes: 8_888,
      updatedAtMs: NOW_MS + 10_000,
    });

    const buffer = new FlushBuffer(
      {
        db,
        registry,
        asnLookup: null,
        isAgentConnected: () => false,
        onRouteChanges: () => {},
      },
      { maxProbeEntries: 100, maxProbeBytes: 10_000, flushIntervalMs: 25 },
    );
    buffer.start();

    await registry.patch("idle", {
      billingConfig: { quotaBytes: 0, mode: "sum", resetDay: 15 },
    });
    expect(registry.hasPendingPeriodRefreshes()).toBe(true);

    // Wait a few tick periods — even though there's no telemetry and no
    // probe activity, the timer must still run doFlush so the drain fires.
    const deadline = Date.now() + 1_000;
    while (registry.hasPendingPeriodRefreshes() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    await buffer.stop();
    expect(registry.hasPendingPeriodRefreshes()).toBe(false);

    const summary = registry.getSummary("idle", NOW_MS + 20_000);
    expect(summary?.billing.rxBytes).toBe(7_777);
    expect(summary?.billing.txBytes).toBe(8_888);
  });

  test("doFlush skips telemetry for an agent already removed from the registry", async () => {
    // Regression for the HELLO-during-DELETE race: a flush can end up with
    // a sample for an agent whose row is already gone (e.g. a fresh session
    // authenticated during the DELETE tx window, sent telemetry, then the
    // admin completed the delete). Without a registry.has guard the flush's
    // INSERT into trafficCounter/trafficDay would FK-violate and roll back
    // the whole batch — dropping every other agent's data in that tick.
    await seedAgent(db, "doomed");
    await seedAgent(db, "sibling");
    await registry.load();

    const buffer = new FlushBuffer(
      {
        db,
        registry,
        asnLookup: null,
        isAgentConnected: () => true,
        onRouteChanges: () => {},
      },
      { maxProbeEntries: 100, maxProbeBytes: 10_000, flushIntervalMs: 10_000 },
    );

    buffer.enqueueTelemetry(makeTelemetry("doomed", 100, 200));
    buffer.enqueueTelemetry(makeTelemetry("sibling", 300, 400));

    // Simulate the race: doomed is gone from registry + DB BEFORE the buffer
    // gets flushed. The buffered sample is still there (it was enqueued on
    // the now-closed ws during the tx window).
    registry.remove("doomed");
    await db.delete(schema.agent).where(eq(schema.agent.id, "doomed"));

    // Flush must NOT crash the batch on an FK error. Sibling's data lands.
    await buffer.stop();

    const trafficDayRows = await db.select().from(schema.trafficDay);
    expect(trafficDayRows).toHaveLength(1);
    expect(trafficDayRows[0]!.agentId).toBe("sibling");
    expect(trafficDayRows[0]!.rxBytes).toBe(300);

    const siblingSummary = registry.getSummary("sibling", NOW_MS + 20_000);
    expect(siblingSummary?.billing.rxBytes).toBe(300);
    expect(siblingSummary?.billing.txBytes).toBe(400);
  });

  test("awaitInflight resolves immediately when no flush is running", async () => {
    const buffer = new FlushBuffer(
      {
        db,
        registry,
        asnLookup: null,
        isAgentConnected: () => true,
        onRouteChanges: () => {},
      },
      { maxProbeEntries: 100, maxProbeBytes: 10_000, flushIntervalMs: 10_000 },
    );

    // Idle buffer → awaitInflight is a no-op.
    const start = Date.now();
    await buffer.awaitInflight();
    expect(Date.now() - start).toBeLessThan(50);
    await buffer.stop();
  });

  test("lastPackWriteMs does not advance when the transaction rolls back", async () => {
    await seedAgent(db, "a1");
    await registry.load();

    let failsRemaining = 1;
    const wrappedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          const txFn: DbClient["transaction"] = ((fn) => {
            if (failsRemaining > 0) {
              failsRemaining -= 1;
              return Promise.reject(new Error("simulated db failure"));
            }
            return target.transaction(fn);
          }) as DbClient["transaction"];
          return txFn;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as DbClient;

    const buffer = new FlushBuffer(
      {
        db: wrappedDb,
        registry,
        asnLookup: null,
        isAgentConnected: () => true,
        onRouteChanges: () => {},
      },
      { maxProbeEntries: 100, maxProbeBytes: 10_000, flushIntervalMs: 10 },
    );

    // The telemetry sample carries a recognizable pack blob so we can
    // assert it actually landed on the agentStatus row after the retry.
    buffer.enqueueTelemetry(makeTelemetry("a1", 100, 200));
    buffer.start();

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const rows = await db
        .select({ pack: schema.agentStatus.lastMetricsPack })
        .from(schema.agentStatus)
        .where(eq(schema.agentStatus.agentId, "a1"));
      if (rows[0]?.pack && rows[0].pack.length > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    await buffer.stop();

    expect(failsRemaining).toBe(0);
    const rows = await db
      .select({ pack: schema.agentStatus.lastMetricsPack })
      .from(schema.agentStatus)
      .where(eq(schema.agentStatus.agentId, "a1"));
    // Without the fix the throttle window would suppress the pack write on
    // retry and `pack` would still be null.
    expect(rows[0]?.pack).toEqual(Buffer.from([0x01]));
  });

  test("transaction failure preserves probe data; the next flush persists it", async () => {
    await seedAgent(db, "a1");
    await db.insert(schema.probeTask).values({
      id: "task-1",
      name: "test-probe",
      kind: "tcp",
      targetJson: "{}",
      intervalSec: 30,
      timeoutMs: 1_000,
      createdAtMs: NOW_MS,
      updatedAtMs: NOW_MS,
    });
    await registry.load();

    let failsRemaining = 1;
    const wrappedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "transaction") {
          const txFn: DbClient["transaction"] = ((fn) => {
            if (failsRemaining > 0) {
              failsRemaining -= 1;
              return Promise.reject(new Error("simulated db failure"));
            }
            return target.transaction(fn);
          }) as DbClient["transaction"];
          return txFn;
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as DbClient;

    const buffer = new FlushBuffer(
      {
        db: wrappedDb,
        registry,
        asnLookup: null,
        isAgentConnected: () => true,
        onRouteChanges: () => {},
      },
      { maxProbeEntries: 100, maxProbeBytes: 10_000, flushIntervalMs: 10 },
    );

    buffer.enqueueProbeResult({
      bytes: 50,
      args: {
        agentId: "a1",
        recvTsMs: NOW_MS + 5_000,
        result: { tid: "task-1", ts: NOW_MS + 5_000, ok: true, lat_ms: 12 },
      },
      isTraceroute: false,
    });
    buffer.start();

    // Poll the DB until the retry succeeds. The first flush rejects (and
    // re-queues), the second commits the row.
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const rows = await db.select().from(schema.probeResult);
      if (rows.length > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }

    await buffer.stop();

    expect(failsRemaining).toBe(0); // confirms the failure injection actually fired
    const probeRows = await db.select().from(schema.probeResult);
    expect(probeRows).toHaveLength(1);
    expect(probeRows[0]!.agentId).toBe("a1");
    expect(probeRows[0]!.taskId).toBe("task-1");
    expect(probeRows[0]!.latMs).toBe(12);
  });
});
