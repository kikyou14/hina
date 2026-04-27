import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/schema";
import { SITE_CONFIG_DEFAULTS, SiteConfigStore } from "../../settings/site-config";
import type { AnyNotifier, SendResult } from "../channels/types";
import type { AlertChannelType, AlertMessageV1 } from "../types";
import { sendTick, type SendTickDeps } from "./dispatcher";

type TestDb = {
  sqlite: Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

function createTestDb(): TestDb {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE alert_channel (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      type text NOT NULL,
      enabled integer NOT NULL,
      config_json text NOT NULL,
      created_at_ms integer NOT NULL,
      updated_at_ms integer NOT NULL
    );
    CREATE TABLE alert_notification (
      id text PRIMARY KEY NOT NULL,
      rule_id text NOT NULL,
      subject_key text NOT NULL,
      channel_id text NOT NULL,
      kind text NOT NULL,
      event_ts_ms integer NOT NULL,
      payload_json text NOT NULL,
      status text NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      next_attempt_at_ms integer NOT NULL,
      last_error text,
      sent_at_ms integer,
      created_at_ms integer NOT NULL,
      updated_at_ms integer NOT NULL
    );
    CREATE INDEX idx_alert_notification_pending
      ON alert_notification(status, next_attempt_at_ms);
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function makeSiteConfig(): SiteConfigStore {
  return new SiteConfigStore({ current: { ...SITE_CONFIG_DEFAULTS } });
}

const FIRE_MESSAGE: AlertMessageV1 = {
  v: 1,
  kind: "firing",
  severity: "warning",
  rule: { id: "rule-1", name: "Test rule", kind: "agent_offline" },
  subject: {
    key: "agent-1",
    agent: { id: "agent-1", name: "agent-1", group: null },
  },
  value: null,
  tsMs: 0,
};

async function seedChannel(
  { db }: TestDb,
  id: string,
  type: AlertChannelType,
  opts: { enabled?: boolean; configJson?: string } = {},
): Promise<void> {
  const now = 1_000_000;
  await db.insert(schema.alertChannel).values({
    id,
    name: id,
    type,
    enabled: opts.enabled ?? true,
    configJson: opts.configJson ?? "{}",
    createdAtMs: now,
    updatedAtMs: now,
  });
}

// Monotonically increasing so insertion order is reflected in createdAtMs,
// which is the final tie-breaker for claimPendingBatch ordering.
let seedCounter = 0;

async function seedNotification(
  { db }: TestDb,
  overrides: Partial<{
    id: string;
    channelId: string;
    nextAttemptAtMs: number;
    payloadJson: string;
    status: "pending" | "sent" | "dead";
    attempts: number;
  }>,
): Promise<string> {
  const id = overrides.id ?? `n-${seedCounter.toString(36)}-${Math.random().toString(36).slice(2)}`;
  const createdAtMs = 1_000_000 + seedCounter++;
  await db.insert(schema.alertNotification).values({
    id,
    ruleId: "rule-1",
    subjectKey: "agent-1",
    channelId: overrides.channelId ?? "ch-1",
    kind: "firing",
    eventTsMs: createdAtMs,
    payloadJson: overrides.payloadJson ?? JSON.stringify(FIRE_MESSAGE),
    status: overrides.status ?? "pending",
    attempts: overrides.attempts ?? 0,
    nextAttemptAtMs: overrides.nextAttemptAtMs ?? 0,
    createdAtMs,
    updatedAtMs: createdAtMs,
  });
  return id;
}

async function readNotification({ db }: TestDb, id: string) {
  const rows = await db
    .select()
    .from(schema.alertNotification)
    .where(eq(schema.alertNotification.id, id));
  return rows[0];
}

// A fake notifier whose send behavior is controlled per-call.
type FakeSend = () => Promise<SendResult>;
function makeFakeNotifier(send: FakeSend, type: AlertChannelType = "webhook"): AnyNotifier {
  return {
    type,
    parseConfig: (_raw) => ({ ok: true, value: {} }),
    redactConfig: () => ({ config: {}, meta: {} }),
    send,
  };
}

function makeDeps(
  harness: TestDb,
  resolver: (type: string) => AnyNotifier | undefined,
  tuning?: SendTickDeps["tuning"],
): SendTickDeps {
  return {
    db: harness.db,
    siteConfig: makeSiteConfig(),
    resolveNotifier: resolver,
    tuning,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let harness: TestDb;

beforeEach(() => {
  harness = createTestDb();
  seedCounter = 0;
});

afterEach(() => {
  harness.sqlite.close();
});

describe("sendTick parallelism", () => {
  test("a slow channel does not block other channels within the same tick", async () => {
    await seedChannel(harness, "slow", "webhook");
    await seedChannel(harness, "fast", "bark");

    const fastOrder: number[] = [];
    const slowOrder: number[] = [];
    let counter = 0;

    const slowNotifier = makeFakeNotifier(async () => {
      await sleep(150);
      slowOrder.push(++counter);
      return { kind: "ok" };
    }, "webhook");
    const fastNotifier = makeFakeNotifier(async () => {
      fastOrder.push(++counter);
      return { kind: "ok" };
    }, "bark");

    const slowId = await seedNotification(harness, { channelId: "slow" });
    const fastId = await seedNotification(harness, { channelId: "fast" });

    await sendTick(makeDeps(harness, (type) => (type === "webhook" ? slowNotifier : fastNotifier)));

    expect(fastOrder[0]).toBeLessThan(slowOrder[0]);

    expect((await readNotification(harness, slowId))?.status).toBe("sent");
    expect((await readNotification(harness, fastId))?.status).toBe("sent");
  });

  test("the tick deadline stops starting new sends; untouched rows stay leased", async () => {
    await seedChannel(harness, "hang", "webhook");
    await seedChannel(harness, "fast", "bark");

    let fastAttempted = 0;
    let hangAttempted = 0;
    let hangStarted: () => void = () => {};
    const hangStartSignal = new Promise<void>((resolve) => {
      hangStarted = resolve;
    });

    const hangNotifier = makeFakeNotifier(() => {
      hangAttempted++;
      hangStarted();
      return new Promise<SendResult>(() => {
        // never
      });
    }, "webhook");
    const fastNotifier = makeFakeNotifier(async () => {
      fastAttempted++;
      return { kind: "ok" };
    }, "bark");

    const hangId0 = await seedNotification(harness, { channelId: "hang" });
    const hangId1 = await seedNotification(harness, { channelId: "hang" });
    const fastId0 = await seedNotification(harness, { channelId: "fast" });
    const fastId1 = await seedNotification(harness, { channelId: "fast" });

    const tickStart = Date.now();
    await sendTick(
      makeDeps(harness, (type) => (type === "webhook" ? hangNotifier : fastNotifier), {
        tickDeadlineMs: 50,
        sendHardTimeoutMs: 200,
        leaseMs: 60_000,
      }),
    );
    await hangStartSignal; // make sure we actually exercised the hanging path
    const elapsed = Date.now() - tickStart;

    // Tick bounded by hard timeout + slack, far below what a serial dispatcher
    // would take on two hanging rows.
    expect(elapsed).toBeLessThan(1_000);

    // Only the first hang row is attempted; the second must be skipped by the
    // deadline check before its serial turn.
    expect(hangAttempted).toBe(1);
    expect(fastAttempted).toBe(2);

    // Fast rows settled as sent.
    expect((await readNotification(harness, fastId0))?.status).toBe("sent");
    expect((await readNotification(harness, fastId1))?.status).toBe("sent");

    // sendTick returns at the tick deadline and hands control back to the
    // interval gate, but the hard-timeout finalisation and the runner's
    // subsequent tail release run in the background. Wait for both to commit
    // before asserting on the hang rows.
    await sleep(300);

    // The attempted hang row is dead-lettered rather than retried: retrying a
    // row whose underlying I/O may still be running would risk a duplicate
    // delivery once the zombie send eventually completes.
    const triedHang = await readNotification(harness, hangId0);
    expect(triedHang?.status).toBe("dead");
    expect(triedHang?.attempts).toBe(1);
    expect(triedHang?.lastError).toMatch(/hard timeout/);

    // The skipped hang row is released back to eligibility so the next tick
    // picks it up almost immediately. Leaving it leased for the full lease
    // window would starve any queue that landed behind a slow one.
    const skippedHang = await readNotification(harness, hangId1);
    expect(skippedHang?.status).toBe("pending");
    expect(skippedHang?.attempts).toBe(0);
    expect(skippedHang?.nextAttemptAtMs).toBeLessThanOrEqual(tickStart);
  });

  test("queues that never reach the dispatch path before the deadline are released, not stranded for the full lease", async () => {
    // Three channels, concurrency of 2: the first two hang long enough to
    // exhaust both runners past the deadline; the third queue's worker runs
    // only after a runner frees up — by then the deadline has already passed.
    await seedChannel(harness, "hang-a", "webhook");
    await seedChannel(harness, "hang-b", "webhook");
    await seedChannel(harness, "late", "bark");

    const hangNotifier = makeFakeNotifier(() => new Promise<SendResult>(() => {}), "webhook");
    let lateSent = 0;
    const lateNotifier = makeFakeNotifier(async () => {
      lateSent++;
      return { kind: "ok" };
    }, "bark");

    await seedNotification(harness, { channelId: "hang-a" });
    await seedNotification(harness, { channelId: "hang-b" });
    const lateId = await seedNotification(harness, { channelId: "late" });

    const tickStart = Date.now();
    await sendTick(
      makeDeps(harness, (type) => (type === "webhook" ? hangNotifier : lateNotifier), {
        channelConcurrency: 2,
        tickDeadlineMs: 50,
        sendHardTimeoutMs: 200,
        leaseMs: 60_000,
      }),
    );

    // Late queue's worker never started a send — its notifier was never
    // invoked — but the row must not be stuck until lease expiry.
    expect(lateSent).toBe(0);
    const late = await readNotification(harness, lateId);
    expect(late?.status).toBe("pending");
    expect(late?.attempts).toBe(0);
    expect(late?.nextAttemptAtMs).toBeLessThanOrEqual(tickStart);

    // Let the hung dispatchers hit their hard timeout so background DB writes
    // commit before afterEach closes the connection.
    await sleep(300);
  });

  test("sendTick returns at the tick deadline instead of waiting for hung workers", async () => {
    await seedChannel(harness, "hang", "webhook");
    const hangNotifier = makeFakeNotifier(() => new Promise<SendResult>(() => {}), "webhook");
    await seedNotification(harness, { channelId: "hang" });

    const tickStart = Date.now();
    await sendTick(
      makeDeps(harness, () => hangNotifier, {
        tickDeadlineMs: 50,
        sendHardTimeoutMs: 500,
        leaseMs: 60_000,
      }),
    );
    const elapsed = Date.now() - tickStart;

    // Without fire-and-forget, sendTick would block until the pool drained
    // (~sendHardTimeoutMs once the hard timeout fires), pinning
    // startIntervalTask's currentTick gate and delaying the next tick by the
    // same margin. The guarantee is that sendTick returns near
    // tickDeadlineMs regardless of worker state.
    expect(elapsed).toBeLessThan(250);

    // Let the hard timeout fire and markDead commit before DB close.
    await sleep(600);
  });
});

describe("sendTick outcome mapping", () => {
  test("notifier throwing is treated as retryable", async () => {
    await seedChannel(harness, "ch-err", "webhook");
    const notifier = makeFakeNotifier(async () => {
      throw new Error("boom");
    });
    const id = await seedNotification(harness, { channelId: "ch-err" });

    await sendTick(makeDeps(harness, () => notifier));

    const row = await readNotification(harness, id);
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("boom");
    expect(row?.nextAttemptAtMs).toBeGreaterThan(Date.now());
  });

  test("fatal result goes straight to dead", async () => {
    await seedChannel(harness, "ch-fatal", "webhook");
    const notifier = makeFakeNotifier(async () => ({ kind: "fatal", error: "permanent" }));
    const id = await seedNotification(harness, { channelId: "ch-fatal" });

    await sendTick(makeDeps(harness, () => notifier));

    const row = await readNotification(harness, id);
    expect(row?.status).toBe("dead");
    expect(row?.lastError).toBe("permanent");
  });

  test("hard timeout dead-letters the row and does not retry when the zombie send eventually resolves", async () => {
    await seedChannel(harness, "ch-zombie", "webhook");

    let resolveUnderlying: (value: SendResult) => void = () => {};
    let sendCalls = 0;
    const notifier = makeFakeNotifier(() => {
      sendCalls++;
      return new Promise<SendResult>((resolve) => {
        resolveUnderlying = resolve;
      });
    });
    const id = await seedNotification(harness, { channelId: "ch-zombie" });

    await sendTick(
      makeDeps(harness, () => notifier, {
        tickDeadlineMs: 1_000,
        sendHardTimeoutMs: 50,
        leaseMs: 60_000,
      }),
    );

    // Hard timeout fired — row is finalised as dead, not retryable.
    let row = await readNotification(harness, id);
    expect(row?.status).toBe("dead");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toMatch(/hard timeout/);

    // The underlying send now "delivers" (zombie I/O finally completes). A
    // subsequent tick must NOT re-dispatch the same row — that would be the
    // duplicate delivery we are guarding against.
    resolveUnderlying({ kind: "ok" });
    await sleep(10);
    await sendTick(
      makeDeps(harness, () => notifier, {
        tickDeadlineMs: 1_000,
        sendHardTimeoutMs: 50,
        leaseMs: 60_000,
      }),
    );

    expect(sendCalls).toBe(1);
    row = await readNotification(harness, id);
    expect(row?.status).toBe("dead");
  });

  test("disabled channel marks rows dead without invoking the notifier", async () => {
    await seedChannel(harness, "ch-off", "webhook", { enabled: false });
    let called = false;
    const notifier = makeFakeNotifier(async () => {
      called = true;
      return { kind: "ok" };
    });
    const id = await seedNotification(harness, { channelId: "ch-off" });

    await sendTick(makeDeps(harness, () => notifier));

    expect(called).toBe(false);
    const row = await readNotification(harness, id);
    expect(row?.status).toBe("dead");
    expect(row?.lastError).toBe("channel disabled");
  });
});

describe("per-channel order", () => {
  test("rows on a shared channel dispatch in nextAttemptAtMs / createdAtMs order, not rowid order", async () => {
    await seedChannel(harness, "ch-order", "webhook");

    const dispatched: string[] = [];
    const notifier = makeFakeNotifier(async () => {
      return { kind: "ok" };
    });
    const wrapped: AnyNotifier = {
      ...notifier,
      parseConfig: (raw) => notifier.parseConfig(raw),
      send: async (ctx, config) => {
        dispatched.push(ctx.message.subject.key);
        return notifier.send(ctx, config);
      },
    };

    // Row A inserted first (smaller rowid) but its retry pushed
    // nextAttemptAtMs > row B's 0. Row B — inserted later, smaller
    // nextAttemptAtMs — must dispatch first.
    const idA = await seedNotification(harness, {
      channelId: "ch-order",
      nextAttemptAtMs: 500,
      payloadJson: JSON.stringify({
        ...FIRE_MESSAGE,
        subject: { ...FIRE_MESSAGE.subject, key: "A" },
      }),
    });
    const idB = await seedNotification(harness, {
      channelId: "ch-order",
      nextAttemptAtMs: 0,
      payloadJson: JSON.stringify({
        ...FIRE_MESSAGE,
        subject: { ...FIRE_MESSAGE.subject, key: "B" },
      }),
    });

    await sendTick(makeDeps(harness, () => wrapped));

    expect(dispatched).toEqual(["B", "A"]);
    expect((await readNotification(harness, idA))?.status).toBe("sent");
    expect((await readNotification(harness, idB))?.status).toBe("sent");
  });
});

describe("dispatcher resilience", () => {
  test("a catastrophic dispatchOne failure is contained; other channels finish and the crashed row stays leased", async () => {
    await seedChannel(harness, "ch-crash", "webhook");
    await seedChannel(harness, "ch-ok", "bark");

    // parseConfig throwing stands in for any non-recoverable dispatchOne
    // failure: SQLite busy on markSent, a notifier parseConfig that violates
    // its contract, etc. These land outside dispatchOne's internal try/catch
    // and propagate up to the sendTick worker.
    const crashNotifier: AnyNotifier = {
      type: "webhook",
      parseConfig: () => {
        throw new Error("db busy");
      },
      redactConfig: () => ({ config: {}, meta: {} }),
      send: async () => ({ kind: "ok" }),
    };
    let okSent = 0;
    const okNotifier = makeFakeNotifier(async () => {
      okSent++;
      return { kind: "ok" };
    }, "bark");

    const crashId = await seedNotification(harness, { channelId: "ch-crash" });
    const okId = await seedNotification(harness, { channelId: "ch-ok" });

    const tickStart = Date.now();
    await sendTick(
      makeDeps(harness, (type) => (type === "webhook" ? crashNotifier : okNotifier), {
        leaseMs: 60_000,
      }),
    );

    // The other channel's row still dispatched — the crash did not poison the
    // worker pool.
    expect(okSent).toBe(1);
    expect((await readNotification(harness, okId))?.status).toBe("sent");

    // The crashed row stays pending and leased. Lease expiry is the recovery
    // path; nothing about its persisted state changes within this tick.
    const crashed = await readNotification(harness, crashId);
    expect(crashed?.status).toBe("pending");
    expect(crashed?.attempts).toBe(0);
    expect(crashed?.lastError).toBeNull();
    expect(crashed?.nextAttemptAtMs).toBeGreaterThan(tickStart + 1_000);
  });
});

describe("claim lease", () => {
  test("overlapping ticks never dispatch the same row twice", async () => {
    await seedChannel(harness, "ch-slow", "webhook");

    let sent = 0;
    const notifier = makeFakeNotifier(async () => {
      await sleep(100);
      sent++;
      return { kind: "ok" };
    });
    const id = await seedNotification(harness, { channelId: "ch-slow" });

    // Kick off two overlapping ticks concurrently.
    await Promise.all([
      sendTick(makeDeps(harness, () => notifier)),
      sendTick(makeDeps(harness, () => notifier)),
    ]);

    expect(sent).toBe(1);
    expect((await readNotification(harness, id))?.status).toBe("sent");
  });
});
