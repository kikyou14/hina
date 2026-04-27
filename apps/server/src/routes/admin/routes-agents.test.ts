import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { AgentRegistry } from "../../agents/registry";
import type { AppContext } from "../../app";
import type { DbClient } from "../../db/client";
import * as schema from "../../db/schema";
import { getMigrationsFolder } from "../../paths";
import type { ProbeDispatcher } from "../../ws/hub";
import { registerAdminAgentsRoutes } from "./routes-agents";
import { registerAdminAlertRoutes } from "./routes-alerts";
import { registerAdminProbeTaskRoutes } from "./routes-probes";

function createTestDb(): { db: DbClient; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema }) as DbClient;
  migrate(db, { migrationsFolder: getMigrationsFolder() });
  return { db, sqlite };
}

async function seedGroup(db: DbClient, id: string, name: string) {
  const nowMs = Date.now();
  await db.insert(schema.agentGroup).values({
    id,
    name,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

async function seedAgent(db: DbClient, id: string, groupId: string | null = null) {
  const nowMs = Date.now();
  await db.insert(schema.agent).values({
    id,
    tokenHash: `hash-${id}`,
    name: id,
    groupId,
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
  await db.insert(schema.agentBilling).values({
    agentId: id,
    quotaBytes: 0,
    mode: "sum",
    resetDay: 1,
    updatedAtMs: nowMs,
  });
}

async function seedProbeTaskGroup(db: DbClient, taskId: string, groupId: string) {
  const nowMs = Date.now();
  await db.insert(schema.probeTask).values({
    id: taskId,
    name: taskId,
    kind: "icmp",
    targetJson: JSON.stringify({ host: "example.com" }),
    intervalSec: 60,
    timeoutMs: 5000,
    enabled: true,
    allAgents: false,
    traceRevealHopDetails: false,
    displayOrder: 0,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  await db.insert(schema.probeTaskGroup).values({
    taskId,
    groupId,
    createdAtMs: nowMs,
  });
}

async function seedAlertRuleForGroup(db: DbClient, ruleId: string, groupId: string) {
  const nowMs = Date.now();
  await db.insert(schema.alertRule).values({
    id: ruleId,
    name: ruleId,
    enabled: true,
    severity: "warning",
    kind: "agent_offline",
    selectorJson: JSON.stringify({ type: "groups", groupIds: [groupId] }),
    paramsJson: "{}",
    forMs: 0,
    recoverMs: 0,
    notifyOnRecovery: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

async function hasGroup(db: DbClient, groupId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.agentGroup.id })
    .from(schema.agentGroup)
    .where(eq(schema.agentGroup.id, groupId));
  return rows.length > 0;
}

function mountAdminAgentsRouter(
  db: DbClient,
  registry: AgentRegistry,
  probeDispatcher?: ProbeDispatcher,
) {
  const app = new Hono<AppContext>();
  app.use(async (c, next) => {
    c.set("db", db);
    c.set("registry", registry);
    if (probeDispatcher) c.set("probeDispatcher", probeDispatcher);
    await next();
  });
  registerAdminAgentsRoutes(app);
  return app;
}

describe("admin agents routes reach CLI-created agents before first HELLO", () => {
  let db: DbClient;
  let sqlite: Database;
  let registry: AgentRegistry;
  let app: ReturnType<typeof mountAdminAgentsRouter>;

  beforeEach(async () => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
    registry = new AgentRegistry(db);
    await registry.load();
    app = mountAdminAgentsRouter(db, registry);
  });

  afterEach(() => sqlite.close());

  test("PATCH /agents/:id lazy-loads a CLI-created agent (does not 404)", async () => {
    await seedAgent(db, "cli-agent");
    // Registry is cold — if the handler still used `registry.has()` it would
    // return 404 here; with `ensureAgent()` it should succeed.
    expect(registry.has("cli-agent")).toBe(false);

    const res = await app.fetch(
      new Request("http://test/agents/cli-agent", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "from-test" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Side effect: ensureAgent pulled it into the registry; PATCH applied.
    expect(registry.has("cli-agent")).toBe(true);
    expect(registry.getAdminDetail("cli-agent")?.note).toBe("from-test");
  });

  test("GET /agents/:id/probe-latest lazy-loads a CLI-created agent (does not 404)", async () => {
    await seedAgent(db, "cli-agent");
    expect(registry.has("cli-agent")).toBe(false);

    const res = await app.fetch(new Request("http://test/agents/cli-agent/probe-latest"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string; results: unknown[] };
    expect(body.agentId).toBe("cli-agent");
    expect(body.results).toEqual([]);
    expect(registry.has("cli-agent")).toBe(true);
  });

  test("PATCH /agents/:id still 404s when the agent truly doesn't exist", async () => {
    const res = await app.fetch(
      new Request("http://test/agents/ghost", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "x" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  test("PATCH /agents/:id updates registry before DB commit (no isPublic leak)", async () => {
    // Regression: if DB is updated first and the registry after, a concurrent
    // anonymous /api/public/agents* read between the two steps would still
    // see the agent as public. The registry must reflect the new isPublic
    // no later than the moment the DB write commits.
    await seedAgent(db, "a1");
    await registry.ensureAgent("a1");
    expect(registry.getSummary("a1")?.isPublic).toBe(true);

    const res = await app.fetch(
      new Request("http://test/agents/a1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isPublic: false }),
      }),
    );
    expect(res.status).toBe(200);

    // Both the registry and the DB must agree — no "stale public" window.
    const [row] = await db
      .select({ isPublic: schema.agent.isPublic })
      .from(schema.agent)
      .where(eq(schema.agent.id, "a1"));
    expect(row?.isPublic).toBe(false);
    expect(registry.getSummary("a1")?.isPublic).toBe(false);
  });

  test("PATCH /agents/:id pushes probe config when the group changes", async () => {
    await seedAgent(db, "a1");
    await registry.ensureAgent("a1");

    const pushedAgentIds: string[] = [];
    const dispatcher: ProbeDispatcher = {
      pushAll: async () => 0,
      pushAgent: async (agentId) => {
        pushedAgentIds.push(agentId);
        return true;
      },
      pushGroup: async () => 0,
      pushRuntimeConfigAll: async () => 0,
      pushRuntimeConfigAgent: async () => false,
      revokeAgent: async () => false,
      quiesceAgent: async () => {},
    };
    const appWithDispatcher = mountAdminAgentsRouter(db, registry, dispatcher);

    const res = await appWithDispatcher.fetch(
      new Request("http://test/agents/a1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupName: "prod" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(pushedAgentIds).toEqual(["a1"]);
  });

  test("PATCH /agents/:id skips probe push when the submitted group is unchanged", async () => {
    await seedGroup(db, "g-prod", "prod");
    await seedAgent(db, "a1", "g-prod");
    await registry.ensureAgent("a1");

    const pushedAgentIds: string[] = [];
    const dispatcher: ProbeDispatcher = {
      pushAll: async () => 0,
      pushAgent: async (agentId) => {
        pushedAgentIds.push(agentId);
        return true;
      },
      pushGroup: async () => 0,
      pushRuntimeConfigAll: async () => 0,
      pushRuntimeConfigAgent: async () => false,
      revokeAgent: async () => false,
      quiesceAgent: async () => {},
    };
    const appWithDispatcher = mountAdminAgentsRouter(db, registry, dispatcher);

    const res = await appWithDispatcher.fetch(
      new Request("http://test/agents/a1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupName: "prod" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(pushedAgentIds).toEqual([]);
  });

  test("PATCH /agents/:id prunes the previous group when it becomes unused", async () => {
    await seedGroup(db, "g-old", "old");
    await seedAgent(db, "a1", "g-old");
    await registry.ensureAgent("a1");

    const res = await app.fetch(
      new Request("http://test/agents/a1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupName: null }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g-old")).toBe(false);
  });

  test("PATCH /agents/:id prunes the previous group when reassigned to a new one", async () => {
    await seedGroup(db, "g-old", "old");
    await seedAgent(db, "a1", "g-old");
    await registry.ensureAgent("a1");

    const res = await app.fetch(
      new Request("http://test/agents/a1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupName: "new" }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g-old")).toBe(false);
    // The freshly-created "new" group must remain — only the abandoned one
    // is pruned.
    const newGroups = await db
      .select({ id: schema.agentGroup.id })
      .from(schema.agentGroup)
      .where(eq(schema.agentGroup.name, "new"));
    expect(newGroups).toHaveLength(1);
    expect(registry.getAdminDetail("a1")?.groupId).toBe(newGroups[0]!.id);
  });

  test("PATCH /agents/:id keeps the previous group when another agent still uses it", async () => {
    await seedGroup(db, "g-shared", "shared");
    await seedAgent(db, "a1", "g-shared");
    await seedAgent(db, "a2", "g-shared");
    await registry.ensureAgent("a1");

    const res = await app.fetch(
      new Request("http://test/agents/a1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupName: null }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g-shared")).toBe(true);
  });

  test("PATCH /agents/:id keeps the previous group when an alert rule targets it", async () => {
    await seedGroup(db, "g-alerts", "alerts");
    await seedAgent(db, "a1", "g-alerts");
    await seedAlertRuleForGroup(db, "rule-1", "g-alerts");
    await registry.ensureAgent("a1");

    const res = await app.fetch(
      new Request("http://test/agents/a1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupName: null }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g-alerts")).toBe(true);
  });

  test("PATCH /agents/:id prunes the previous group when alert LIKE candidates are false positives", async () => {
    await seedGroup(db, "g", "short");
    await seedAgent(db, "a1", "g");
    await seedAlertRuleForGroup(db, "rule-1", "g-other");
    await registry.ensureAgent("a1");

    const res = await app.fetch(
      new Request("http://test/agents/a1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupName: null }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g")).toBe(false);
  });

  test("DELETE /agents/:id fences with quiesceAgent BEFORE the tx AND revokeAgent AFTER", async () => {
    // Regression: a HELLO arriving between `quiesceAgent` and DELETE's tx
    // can authenticate (tokenHash still committed) and register a fresh
    // session. Without a post-commit revoke that session survives the
    // DELETE and its next telemetry flush hits the FK rollback on
    // trafficDay/trafficCounter this fence is meant to prevent.
    await seedAgent(db, "doomed");
    await registry.ensureAgent("doomed");

    const callOrder: string[] = [];
    const dispatcher = {
      pushAll: async () => 0,
      pushAgent: async () => false,
      pushGroup: async () => 0,
      pushRuntimeConfigAll: async () => 0,
      pushRuntimeConfigAgent: async () => false,
      revokeAgent: async () => {
        callOrder.push("revokeAgent");
        return false;
      },
      quiesceAgent: async () => {
        callOrder.push("quiesceAgent");
      },
    };

    // Re-mount with dispatcher in context.
    const app2 = new Hono<AppContext>();
    app2.use(async (c, next) => {
      c.set("db", db);
      c.set("registry", registry);
      c.set("probeDispatcher", dispatcher);
      callOrder.push("request-start");
      await next();
      callOrder.push("request-end");
    });
    registerAdminAgentsRoutes(app2);

    const res = await app2.fetch(new Request("http://test/agents/doomed", { method: "DELETE" }));
    expect(res.status).toBe(200);

    // Ordering: quiesceAgent before tx, revokeAgent after tx, both inside
    // the single HTTP request.
    expect(callOrder).toEqual(["request-start", "quiesceAgent", "revokeAgent", "request-end"]);
    expect(registry.has("doomed")).toBe(false);
    const remaining = await db
      .select({ id: schema.agent.id })
      .from(schema.agent)
      .where(eq(schema.agent.id, "doomed"));
    expect(remaining).toHaveLength(0);
  });

  test("DELETE /agents/:id prunes the previous group when it becomes unused", async () => {
    await seedGroup(db, "g-old", "old");
    await seedAgent(db, "a1", "g-old");
    await registry.ensureAgent("a1");

    const res = await app.fetch(new Request("http://test/agents/a1", { method: "DELETE" }));

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g-old")).toBe(false);
  });

  test("DELETE /agents/:id keeps the previous group when a probe task targets it", async () => {
    await seedGroup(db, "g-probes", "probes");
    await seedAgent(db, "a1", "g-probes");
    await seedProbeTaskGroup(db, "task-1", "g-probes");
    await registry.ensureAgent("a1");

    const res = await app.fetch(new Request("http://test/agents/a1", { method: "DELETE" }));

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g-probes")).toBe(true);
  });
});

function mountAdminProbeRouter(db: DbClient) {
  const app = new Hono<AppContext>();
  app.use(async (c, next) => {
    c.set("db", db);
    await next();
  });
  registerAdminProbeTaskRoutes(app);
  return app;
}

function mountAdminAlertRouter(db: DbClient) {
  const app = new Hono<AppContext>();
  app.use(async (c, next) => {
    c.set("db", db);
    await next();
  });
  registerAdminAlertRoutes(app);
  return app;
}

describe("group prune hooks fire from probe and alert routes", () => {
  let db: DbClient;
  let sqlite: Database;

  beforeEach(() => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
  });

  afterEach(() => sqlite.close());

  test("DELETE /probe-tasks/:id prunes a group it solely referenced", async () => {
    await seedGroup(db, "g-only-here", "only-here");
    await seedProbeTaskGroup(db, "task-1", "g-only-here");

    const app = mountAdminProbeRouter(db);
    const res = await app.fetch(
      new Request("http://test/probe-tasks/task-1", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g-only-here")).toBe(false);
  });

  test("DELETE /probe-tasks/:id keeps a group an agent still uses", async () => {
    await seedGroup(db, "g-shared", "shared");
    await seedAgent(db, "a1", "g-shared");
    await seedProbeTaskGroup(db, "task-1", "g-shared");

    const app = mountAdminProbeRouter(db);
    const res = await app.fetch(
      new Request("http://test/probe-tasks/task-1", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g-shared")).toBe(true);
  });

  test("PATCH /probe-tasks/:id prunes groups dropped from the task's scope", async () => {
    await seedGroup(db, "g-keep", "keep");
    await seedGroup(db, "g-drop", "drop");
    // probe task targets both groups initially
    await seedProbeTaskGroup(db, "task-1", "g-keep");
    await db.insert(schema.probeTaskGroup).values({
      taskId: "task-1",
      groupId: "g-drop",
      createdAtMs: Date.now(),
    });

    const app = mountAdminProbeRouter(db);
    const res = await app.fetch(
      new Request("http://test/probe-tasks/task-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groupIds: ["g-keep"] }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g-keep")).toBe(true);
    expect(await hasGroup(db, "g-drop")).toBe(false);
  });

  test("DELETE /alert-rules/:id prunes a group it solely referenced", async () => {
    await seedGroup(db, "g-only-alert", "only-alert");
    await seedAlertRuleForGroup(db, "rule-1", "g-only-alert");

    const app = mountAdminAlertRouter(db);
    const res = await app.fetch(
      new Request("http://test/alert-rules/rule-1", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g-only-alert")).toBe(false);
  });

  test("PATCH /alert-rules/:id prunes groups dropped from the selector", async () => {
    await seedGroup(db, "g-keep", "keep");
    await seedGroup(db, "g-drop", "drop");
    const nowMs = Date.now();
    await db.insert(schema.alertRule).values({
      id: "rule-1",
      name: "rule-1",
      enabled: true,
      severity: "warning",
      kind: "agent_offline",
      selectorJson: JSON.stringify({ type: "groups", groupIds: ["g-keep", "g-drop"] }),
      paramsJson: "{}",
      forMs: 0,
      recoverMs: 0,
      notifyOnRecovery: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });

    const app = mountAdminAlertRouter(db);
    const res = await app.fetch(
      new Request("http://test/alert-rules/rule-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selector: { type: "groups", groupIds: ["g-keep"] } }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await hasGroup(db, "g-keep")).toBe(true);
    expect(await hasGroup(db, "g-drop")).toBe(false);
  });
});
