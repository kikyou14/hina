import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { DbClient } from "../db/client";
import * as schema from "../db/schema";
import { getMigrationsFolder } from "../paths";
import {
  buildProbeConfigForAgent,
  capabilitySupportsTracerouteTcpSizePair,
  computeTracerouteTcpSupportCounts,
  fetchAgentProbeScope,
} from "./probe-config";

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

async function seedAllAgentsTask(db: DbClient, taskId: string, kind: string, target: unknown) {
  await db.insert(schema.probeTask).values({
    id: taskId,
    name: taskId,
    kind,
    targetJson: JSON.stringify(target),
    intervalSec: 60,
    timeoutMs: 5_000,
    enabled: true,
    allAgents: true,
    createdAtMs: NOW_MS,
    updatedAtMs: NOW_MS,
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

describe("capabilitySupportsTracerouteTcpSizePair", () => {
  test("true only when probes.traceroute.tcpSizePair is exactly true", () => {
    expect(
      capabilitySupportsTracerouteTcpSizePair({
        probes: { traceroute: { protocols: ["icmp", "tcp"], tcpSizePair: true } },
      }),
    ).toBe(true);
  });

  test.each([
    undefined,
    null,
    {},
    { probes: {} },
    { probes: { traceroute: {} } },
    { probes: { traceroute: { tcpSizePair: false } } },
    { probes: { traceroute: { tcpSizePair: "true" } } },
    { probes: null },
    { probes: { traceroute: null } },
    "not an object",
    42,
  ])("false for missing/malformed capability %p", (cap) => {
    expect(capabilitySupportsTracerouteTcpSizePair(cap)).toBe(false);
  });
});

describe("buildProbeConfigForAgent — TCP dual-size traceroute capability gating", () => {
  let db: DbClient;
  let sqlite: Database;

  beforeEach(async () => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
    await seedAgent(db, "a1", null);

    await seedAllAgentsTask(db, "task-icmp", "traceroute", { host: "1.1.1.1" });
    await seedAllAgentsTask(db, "task-tcp", "traceroute", {
      host: "example.com",
      protocol: "tcp",
      port: 443,
      packetSizes: [64, 1400],
    });
  });

  afterEach(() => sqlite.close());

  test("withholds the TCP dual-size task when capability is unset (safe default)", async () => {
    const scope = await fetchAgentProbeScope(db, "a1");
    if (!scope) throw new Error("missing scope");

    const body = await buildProbeConfigForAgent(db, "a1", { scope, rev: 1 });

    expect(body.tasks.map((t) => t.id).sort()).toEqual(["task-icmp"]);
  });

  test("withholds the TCP dual-size task when capability is explicitly false", async () => {
    const scope = await fetchAgentProbeScope(db, "a1");
    if (!scope) throw new Error("missing scope");

    const body = await buildProbeConfigForAgent(db, "a1", {
      scope,
      rev: 1,
      supportsTracerouteTcpSizePair: false,
    });

    expect(body.tasks.map((t) => t.id).sort()).toEqual(["task-icmp"]);
  });

  test("includes both tasks when the agent declares tcpSizePair support", async () => {
    const scope = await fetchAgentProbeScope(db, "a1");
    if (!scope) throw new Error("missing scope");

    const body = await buildProbeConfigForAgent(db, "a1", {
      scope,
      rev: 1,
      supportsTracerouteTcpSizePair: true,
    });

    expect(body.tasks.map((t) => t.id).sort()).toEqual(["task-icmp", "task-tcp"]);
  });

  test("ICMP traceroute is never gated by the capability flag", async () => {
    const scope = await fetchAgentProbeScope(db, "a1");
    if (!scope) throw new Error("missing scope");

    const withoutCap = await buildProbeConfigForAgent(db, "a1", { scope, rev: 1 });
    const withCap = await buildProbeConfigForAgent(db, "a1", {
      scope,
      rev: 2,
      supportsTracerouteTcpSizePair: true,
    });

    expect(withoutCap.tasks.some((t) => t.id === "task-icmp")).toBe(true);
    expect(withCap.tasks.some((t) => t.id === "task-icmp")).toBe(true);
  });
});

describe("computeTracerouteTcpSupportCounts", () => {
  let db: DbClient;
  let sqlite: Database;

  const TCP_TARGET_JSON = JSON.stringify({
    host: "example.com",
    protocol: "tcp",
    port: 443,
    packetSizes: [64, 1400],
  });

  beforeEach(() => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
  });

  afterEach(() => sqlite.close());

  async function seedAgentWithCap(id: string, groupId: string | null, supportsTcp: boolean) {
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
    // Capabilities live on agentStatus, populated from the HELLO handshake.
    await db.insert(schema.agentStatus).values({
      agentId: id,
      lastCapabilitiesJson: JSON.stringify({
        probes: { traceroute: { tcpSizePair: supportsTcp } },
      }),
      updatedAtMs: NOW_MS,
    });
  }

  async function seedScopedTcpTask(taskId: string) {
    await db.insert(schema.probeTask).values({
      id: taskId,
      name: taskId,
      kind: "traceroute",
      targetJson: TCP_TARGET_JSON,
      intervalSec: 60,
      timeoutMs: 5_000,
      enabled: true,
      allAgents: false,
      createdAtMs: NOW_MS,
      updatedAtMs: NOW_MS,
    });
  }

  test("counts unsupported target agents across an allAgents task", async () => {
    await seedAgentWithCap("a1", null, true);
    await seedAgentWithCap("a2", null, false);
    await seedAgentWithCap("a3", null, false);

    const counts = await computeTracerouteTcpSupportCounts(db, [
      { id: "t-all", kind: "traceroute", targetJson: TCP_TARGET_JSON, allAgents: true },
    ]);

    expect(counts.get("t-all")).toEqual({ targetAgents: 3, unsupportedAgents: 2 });
  });

  test("counts within a specific-agent scope only", async () => {
    await seedAgentWithCap("a1", null, true);
    await seedAgentWithCap("a2", null, false);
    await seedScopedTcpTask("t-scoped");
    await db.insert(schema.probeTaskAgent).values({
      taskId: "t-scoped",
      agentId: "a2",
      createdAtMs: NOW_MS,
    });

    const counts = await computeTracerouteTcpSupportCounts(db, [
      { id: "t-scoped", kind: "traceroute", targetJson: TCP_TARGET_JSON, allAgents: false },
    ]);

    // Only a2 is in scope, and it is unsupported; a1 (supported) is out of scope.
    expect(counts.get("t-scoped")).toEqual({ targetAgents: 1, unsupportedAgents: 1 });
  });

  test("counts group members for a group-scoped task", async () => {
    await seedGroup(db, "g1", "group-1");
    await seedAgentWithCap("a1", "g1", true);
    await seedAgentWithCap("a2", "g1", false);
    await seedAgentWithCap("a3", null, false); // outside the group — must not count
    await seedScopedTcpTask("t-group");
    await db.insert(schema.probeTaskGroup).values({
      taskId: "t-group",
      groupId: "g1",
      createdAtMs: NOW_MS,
    });

    const counts = await computeTracerouteTcpSupportCounts(db, [
      { id: "t-group", kind: "traceroute", targetJson: TCP_TARGET_JSON, allAgents: false },
    ]);

    expect(counts.get("t-group")).toEqual({ targetAgents: 2, unsupportedAgents: 1 });
  });

  test("omits non-TCP traceroute tasks and other probe kinds", async () => {
    await seedAgentWithCap("a1", null, false);

    const counts = await computeTracerouteTcpSupportCounts(db, [
      {
        id: "icmp",
        kind: "traceroute",
        targetJson: JSON.stringify({ host: "1.1.1.1" }),
        allAgents: true,
      },
      {
        id: "tcp",
        kind: "tcp",
        targetJson: JSON.stringify({ host: "x", port: 80 }),
        allAgents: true,
      },
    ]);

    expect(counts.size).toBe(0);
  });

  test("returns an empty map when no TCP dual-size tasks are present", async () => {
    const counts = await computeTracerouteTcpSupportCounts(db, []);
    expect(counts.size).toBe(0);
  });
});
