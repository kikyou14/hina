import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { DbClient } from "../db/client";
import * as schema from "../db/schema";
import { markAgentOffline } from "../ingest/status";
import { getMigrationsFolder } from "../paths";
import {
  ingestTelemetryTrafficAndRollup,
  upsertAgentStatusFromTelemetry,
  type TelemetryIngestArgs,
} from "./telemetry";

function createTestDb(): { db: DbClient; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema }) as DbClient;
  migrate(db, { migrationsFolder: getMigrationsFolder() });
  return { db, sqlite };
}

async function seedAgent(db: DbClient, id: string) {
  const nowMs = 1_700_000_000_000;
  await db.insert(schema.agent).values({
    id,
    tokenHash: `hash-${id}`,
    name: id,
    isPublic: true,
    displayOrder: 0,
    tagsJson: "[]",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  await db.insert(schema.agentStatus).values({
    agentId: id,
    online: false,
    updatedAtMs: nowMs,
  });
}

function telemetryArgs(
  agentId: string,
  overrides: Partial<TelemetryIngestArgs> = {},
): TelemetryIngestArgs {
  return {
    agentId,
    recvTsMs: 1_700_000_000_000,
    seq: 1,
    uptimeSec: 100,
    rxBytesTotal: 1024,
    txBytesTotal: 2048,
    latestTelemetryPack: Buffer.from([0xff, 0xee]),
    numericMetrics: {},
    ...overrides,
  };
}

describe("telemetry ingest split", () => {
  let db: DbClient;
  let sqlite: Database;

  beforeEach(() => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
  });
  afterEach(() => sqlite.close());

  test("ingestTelemetryTrafficAndRollup persists traffic without touching agentStatus", async () => {
    await seedAgent(db, "a1");

    // First sample seeds the trafficCounter baseline (delta=0, no trafficDay row).
    await db.transaction(async (tx) => {
      await ingestTelemetryTrafficAndRollup(
        tx,
        telemetryArgs("a1", { seq: 1, rxBytesTotal: 0, txBytesTotal: 0 }),
      );
    });

    // Pretend the agent has just disconnected: close() wrote markOffline.
    await db.transaction((tx) => markAgentOffline(tx, "a1", 1_000_000));

    // Second sample (buffered just before disconnect) should flush its traffic
    // delta into trafficDay/rollup WITHOUT flipping agentStatus back online.
    await db.transaction(async (tx) => {
      await ingestTelemetryTrafficAndRollup(
        tx,
        telemetryArgs("a1", { seq: 2, rxBytesTotal: 1024, txBytesTotal: 2048 }),
      );
    });

    const traffic = await db.select().from(schema.trafficDay);
    expect(traffic).toHaveLength(1);
    expect(traffic[0]!.rxBytes).toBe(1024);
    expect(traffic[0]!.txBytes).toBe(2048);

    // agentStatus is still offline — we did NOT call upsertAgentStatus.
    const status = await db
      .select({ online: schema.agentStatus.online })
      .from(schema.agentStatus)
      .where(eq(schema.agentStatus.agentId, "a1"));
    expect(status[0]?.online).toBe(false);
  });

  test("upsertAgentStatusFromTelemetry writes online + lastMetricsPack when called", async () => {
    await seedAgent(db, "a1");

    await db.transaction(async (tx) => {
      await upsertAgentStatusFromTelemetry(tx, telemetryArgs("a1"));
    });

    const status = await db
      .select()
      .from(schema.agentStatus)
      .where(eq(schema.agentStatus.agentId, "a1"));
    expect(status[0]?.online).toBe(true);
    expect(status[0]?.lastMetricsPack).toEqual(Buffer.from([0xff, 0xee]));
  });
});
