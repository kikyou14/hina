import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { DbClient } from "../db/client";
import * as schema from "../db/schema";
import { getMigrationsFolder } from "../paths";
import { buildProbeConfigForAgent, fetchAgentProbeScope } from "./probe-config";

const NOW_MS = 1_700_000_000_000;

function createTestDb(): { db: DbClient; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema }) as DbClient;
  migrate(db, { migrationsFolder: getMigrationsFolder() });
  return { db, sqlite };
}

async function seedGroup(db: DbClient, id: string, name: string) {
  await db.insert(schema.agentGroup).values({
    id,
    name,
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
  });
}

async function seedAgent(db: DbClient, id: string, groupId: string | null) {
  await db.insert(schema.agent).values({
    id,
    tokenHash: `hash-${id}`,
    name: id,
    groupId,
    isPublic: true,
    displayOrder: 0,
    tagsJson: "[]",
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
  });
}

async function seedGroupProbeTask(db: DbClient, taskId: string, groupId: string) {
  await db.insert(schema.probeTask).values({
    id: taskId,
    name: taskId,
    kind: "icmp",
    targetJson: JSON.stringify({ host: "1.1.1.1" }),
    intervalSec: 60,
    timeoutMs: 5_000,
    enabled: true,
    allAgents: false,
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
  });
  await db.insert(schema.probeTaskGroup).values({
    taskId,
    groupId,
    createdAtMs: NOW_MS,
  });
}

describe("buildProbeConfigForAgent", () => {
  let db: DbClient;
  let sqlite: Database;

  beforeEach(() => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
  });

  afterEach(() => sqlite.close());

  test("returns null for a missing agent scope", async () => {
    await expect(fetchAgentProbeScope(db, "missing-agent")).resolves.toBeNull();
  });

  test("uses the current DB group when rebuilding config for an existing connection", async () => {
    await seedGroup(db, "g-old", "old");
    await seedGroup(db, "g-new", "new");
    await seedAgent(db, "a1", "g-old");
    await seedGroupProbeTask(db, "task-new-group", "g-new");

    const beforeScope = await fetchAgentProbeScope(db, "a1");
    expect(beforeScope?.groupId).toBe("g-old");
    if (!beforeScope) throw new Error("missing before scope");
    const beforeMove = await buildProbeConfigForAgent(db, "a1", {
      scope: beforeScope,
      rev: 101,
    });
    expect(beforeMove.rev).toBe(101);
    expect(beforeMove.tasks.map((task) => task.id)).toEqual([]);

    await db
      .update(schema.agent)
      .set({ groupId: "g-new", updatedAtMs: NOW_MS + 1 })
      .where(eq(schema.agent.id, "a1"));

    const afterScope = await fetchAgentProbeScope(db, "a1");
    expect(afterScope?.groupId).toBe("g-new");
    if (!afterScope) throw new Error("missing after scope");
    const afterMove = await buildProbeConfigForAgent(db, "a1", {
      scope: afterScope,
      rev: 102,
    });
    expect(afterMove.rev).toBe(102);
    expect(afterMove.tasks.map((task) => task.id)).toEqual(["task-new-group"]);
  });
});
