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
  computeProbeSupportCounts,
  fetchAgentProbeScope,
} from "./probe-config";

import {
  type ProbeCapability,
  requiredProbeCapabilities,
  supportedProbeCapabilities,
} from "../util/probe-capabilities";

function supports(cap: unknown, capability: ProbeCapability): boolean {
  return supportedProbeCapabilities(cap).has(capability);
}

function capabilities(...names: ProbeCapability[]): Set<ProbeCapability> {
  return new Set(names);
}

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

describe("tracerouteTcpSizePair capability", () => {
  test("true only when probes.traceroute.tcpSizePair is exactly true", () => {
    expect(
      supports(
        { probes: { traceroute: { protocols: ["icmp", "tcp"], tcpSizePair: true } } },
        "tracerouteTcpSizePair",
      ),
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
    expect(supports(cap, "tracerouteTcpSizePair")).toBe(false);
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
      capabilities: capabilities(),
    });

    expect(body.tasks.map((t) => t.id).sort()).toEqual(["task-icmp"]);
  });

  test("includes both tasks when the agent declares tcpSizePair support", async () => {
    const scope = await fetchAgentProbeScope(db, "a1");
    if (!scope) throw new Error("missing scope");

    const body = await buildProbeConfigForAgent(db, "a1", {
      scope,
      rev: 1,
      capabilities: capabilities("tracerouteTcpSizePair"),
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
      capabilities: capabilities("tracerouteTcpSizePair"),
    });

    expect(withoutCap.tasks.some((t) => t.id === "task-icmp")).toBe(true);
    expect(withCap.tasks.some((t) => t.id === "task-icmp")).toBe(true);
  });
});

describe("computeProbeSupportCounts", () => {
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

    const counts = await computeProbeSupportCounts(db, [
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

    const counts = await computeProbeSupportCounts(db, [
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

    const counts = await computeProbeSupportCounts(db, [
      { id: "t-group", kind: "traceroute", targetJson: TCP_TARGET_JSON, allAgents: false },
    ]);

    expect(counts.get("t-group")).toEqual({ targetAgents: 2, unsupportedAgents: 1 });
  });

  test("omits non-TCP traceroute tasks and other probe kinds", async () => {
    await seedAgentWithCap("a1", null, false);

    const counts = await computeProbeSupportCounts(db, [
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
    const counts = await computeProbeSupportCounts(db, []);
    expect(counts.size).toBe(0);
  });
});

describe("TCP fixed packet size capability", () => {
  test("requires its own exact capability, not traceroute support", () => {
    expect(supports({ probes: { tcp: { packetSize: true } } }, "tcpPacketSize")).toBe(true);
    for (const cap of [
      null,
      {},
      { probes: { traceroute: { tcpSizePair: true } } },
      { probes: { tcp: { packetSize: "true" } } },
    ]) {
      expect(supports(cap, "tcpPacketSize")).toBe(false);
    }
  });

  test("filters unsupported tasks and counts mixed groups using the separate capability", async () => {
    const { db, sqlite } = createTestDb();
    try {
      await seedGroup(db, "g1", "group-1");
      await seedAgent(db, "linux", "g1");
      await seedAgent(db, "old-linux", "g1");
      for (const [id, cap] of [
        ["linux", { probes: { tcp: { packetSize: true } } }],
        ["old-linux", { probes: { traceroute: { tcpSizePair: true } } }],
      ] as const) {
        await db
          .insert(schema.agentStatus)
          .values({ agentId: id, lastCapabilitiesJson: JSON.stringify(cap), updatedAtMs: NOW_MS });
      }
      await seedAllAgentsTask(db, "normal", "tcp", { host: "::1", port: 443 });
      await seedAllAgentsTask(db, "sized", "tcp", {
        host: "example.com",
        port: 443,
        packetSize: 1200,
      });
      await db
        .update(schema.probeTask)
        .set({ allAgents: false })
        .where(eq(schema.probeTask.id, "sized"));
      await db
        .insert(schema.probeTaskGroup)
        .values({ taskId: "sized", groupId: "g1", createdAtMs: NOW_MS });
      await db
        .insert(schema.probeTaskAgent)
        .values({ taskId: "sized", agentId: "linux", createdAtMs: NOW_MS });
      const scope = { agentId: "linux", groupId: "g1" };
      for (const advertised of [capabilities("tracerouteTcpSizePair"), undefined]) {
        const result = await buildProbeConfigForAgent(db, "linux", {
          scope,
          rev: 1,
          capabilities: advertised,
        });
        expect(result.tasks.map((task) => task.id)).toEqual(["normal"]);
      }
      const supported = await buildProbeConfigForAgent(db, "linux", {
        scope,
        rev: 2,
        capabilities: capabilities("tcpPacketSize"),
      });
      expect(supported.tasks.find((task) => task.id === "sized")?.tar).toEqual({
        host: "example.com",
        port: 443,
        packetSize: 1200,
      });
      const counts = await computeProbeSupportCounts(db, [
        {
          id: "sized",
          kind: "tcp",
          targetJson: JSON.stringify({ host: "example.com", port: 443, packetSize: 1200 }),
          allAgents: false,
        },
      ]);
      expect(counts.get("sized")).toEqual({ targetAgents: 2, unsupportedAgents: 1 });
    } finally {
      sqlite.close();
    }
  });
});

describe("ICMP IPv6 traceroute capability", () => {
  test("requires its own exact capability", () => {
    expect(supports({ probes: { traceroute: { icmpIpv6: true } } }, "tracerouteIcmpIpv6")).toBe(
      true,
    );
    for (const cap of [
      null,
      {},
      { probes: { traceroute: { tcpSizePair: true } } },
      { probes: { traceroute: { icmpIpv6: "true" } } },
    ]) {
      expect(supports(cap, "tracerouteIcmpIpv6")).toBe(false);
    }
  });

  test("withholds only IPv6 literal targets from agents without the capability", async () => {
    const { db, sqlite } = createTestDb();
    try {
      await seedAgent(db, "a1", null);
      await seedAllAgentsTask(db, "v4", "traceroute", { host: "203.0.113.10" });
      await seedAllAgentsTask(db, "hostname", "traceroute", { host: "example.com" });
      await seedAllAgentsTask(db, "v6", "traceroute", { host: "2001:db8::1" });
      const scope = { agentId: "a1", groupId: null };

      const legacy = await buildProbeConfigForAgent(db, "a1", { scope, rev: 1 });
      expect(legacy.tasks.map((t) => t.id).sort()).toEqual(["hostname", "v4"]);

      const capable = await buildProbeConfigForAgent(db, "a1", {
        scope,
        rev: 2,
        capabilities: capabilities("tracerouteIcmpIpv6"),
      });
      expect(capable.tasks.map((t) => t.id).sort()).toEqual(["hostname", "v4", "v6"]);
    } finally {
      sqlite.close();
    }
  });

  test("counts target agents that would skip an IPv6 traceroute", async () => {
    const { db, sqlite } = createTestDb();
    try {
      for (const [id, cap] of [
        ["new", { probes: { traceroute: { icmpIpv6: true } } }],
        ["old", { probes: { traceroute: { tcpSizePair: true } } }],
      ] as const) {
        await seedAgent(db, id, null);
        await db
          .insert(schema.agentStatus)
          .values({ agentId: id, lastCapabilitiesJson: JSON.stringify(cap), updatedAtMs: NOW_MS });
      }

      const counts = await computeProbeSupportCounts(db, [
        {
          id: "v6",
          kind: "traceroute",
          targetJson: JSON.stringify({ host: "2001:db8::1" }),
          allAgents: true,
        },
        {
          id: "v4",
          kind: "traceroute",
          targetJson: JSON.stringify({ host: "203.0.113.10" }),
          allAgents: true,
        },
      ]);
      expect(counts.get("v6")).toEqual({ targetAgents: 2, unsupportedAgents: 1 });
      expect(counts.has("v4")).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});

describe("requiredProbeCapabilities", () => {
  test.each([
    ["icmp", { host: "2001:db8::1" }, []],
    ["icmp", { host: "example.com", family: "ipv6" }, ["addressFamily"]],
    ["tcp", { host: "example.com", port: 443 }, []],
    ["tcp", { host: "example.com", port: 443, family: "ipv6" }, ["addressFamily"]],
    ["tcp", { host: "example.com", port: 443, packetSize: 1200 }, ["tcpPacketSize"]],
    [
      "tcp",
      { host: "example.com", port: 443, packetSize: 1400 },
      ["tcpPacketSize", "tcpPacketSizeRange"],
    ],
    [
      "tcp",
      { host: "2001:db8::1", port: 443, packetSize: 1200 },
      ["tcpPacketSize", "tcpPacketSizeIpv6"],
    ],
    [
      "tcp",
      { host: "example.com", family: "ipv6", port: 443, packetSize: 1500 },
      ["addressFamily", "tcpPacketSize", "tcpPacketSizeRange", "tcpPacketSizeIpv6"],
    ],
    ["traceroute", { host: "example.com" }, []],
    [
      "traceroute",
      { host: "example.com", family: "ipv6" },
      ["addressFamily", "tracerouteIcmpIpv6"],
    ],
    [
      "traceroute",
      { host: "2001:db8::1", protocol: "tcp", port: 443, packetSizes: [60, 1500] },
      ["tracerouteTcpSizePair", "tracerouteTcpSizePairIpv6"],
    ],
    ["http", { url: "https://example.com" }, []],
  ] as const)("%s %p needs %p", (kind, target, required) => {
    expect(requiredProbeCapabilities(kind, target)).toEqual([...required]);
  });
});

describe("IPv6 and family-pinned TCP gating", () => {
  test("withholds IPv6 raw TCP and family-pinned tasks from agents that predate them", async () => {
    const { db, sqlite } = createTestDb();
    try {
      await seedAgent(db, "a1", null);
      await seedAllAgentsTask(db, "v4-sized", "tcp", {
        host: "example.com",
        port: 443,
        packetSize: 40,
      });
      await seedAllAgentsTask(db, "v6-sized", "tcp", {
        host: "example.com",
        family: "ipv6",
        port: 443,
        packetSize: 1400,
      });
      await seedAllAgentsTask(db, "v6-connect", "tcp", {
        host: "example.com",
        family: "ipv6",
        port: 443,
      });
      const scope = { agentId: "a1", groupId: null };

      // What a 0.3.0 Linux agent advertises.
      const legacy = await buildProbeConfigForAgent(db, "a1", {
        scope,
        rev: 1,
        capabilities: supportedProbeCapabilities({
          probes: { tcp: { packetSize: true }, traceroute: { tcpSizePair: true, icmpIpv6: true } },
        }),
      });
      expect(legacy.tasks.map((t) => t.id)).toEqual(["v4-sized"]);

      const current = await buildProbeConfigForAgent(db, "a1", {
        scope,
        rev: 2,
        capabilities: supportedProbeCapabilities({
          probes: {
            family: true,
            tcp: { packetSize: true, packetSizeRange: true, packetSizeIpv6: true },
          },
        }),
      });
      expect(current.tasks.map((t) => t.id).sort()).toEqual(["v4-sized", "v6-connect", "v6-sized"]);
    } finally {
      sqlite.close();
    }
  });
});
