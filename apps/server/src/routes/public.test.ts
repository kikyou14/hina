import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { AgentRegistry } from "../agents/registry";
import type { AppContext } from "../app";
import { SessionTouchThrottler } from "../auth/session";
import type { DbClient } from "../db/client";
import * as schema from "../db/schema";
import { getMigrationsFolder } from "../paths";
import { SiteConfigStore, type SiteConfig } from "../settings/site-config";
import { createPublicRouter } from "./public";

function createTestDb(): { db: DbClient; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema }) as DbClient;
  migrate(db, { migrationsFolder: getMigrationsFolder() });
  return { db, sqlite };
}

async function seedAgent(db: DbClient, args: { id: string; name: string; isPublic?: boolean }) {
  const nowMs = Date.now();
  await db.insert(schema.agent).values({
    id: args.id,
    tokenHash: `hash-${args.id}`,
    name: args.name,
    isPublic: args.isPublic ?? true,
    displayOrder: 0,
    tagsJson: "[]",
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
    quotaBytes: 0,
    mode: "sum",
    resetDay: 1,
    updatedAtMs: nowMs,
  });
}

function mountPublicRouter(db: DbClient, registry: AgentRegistry) {
  const app = new Hono<AppContext>();

  const siteConfig: SiteConfig = {
    siteName: "Test",
    siteDescription: "",
    favicon: "",
    customHeadHtml: "",
    customFooterHtml: "",
    timezone: "UTC",
    sortOfflineLast: false,
    hideTracerouteForGuests: false,
    publicBaseUrl: "",
    versionCheckEnabled: false,
  };
  const siteStore = new SiteConfigStore({ current: siteConfig });

  app.use(async (c, next) => {
    c.set("db", db);
    c.set("registry", registry);
    c.set("siteConfig", siteStore);
    await next();
  });

  app.route("/api/public", createPublicRouter(new SessionTouchThrottler()));
  return app;
}

// Rate-limiter middleware reads `c.env.connectionIp`; satisfy it with a
// placeholder since this test doesn't care about rate limits.
async function fetchPublic(
  app: ReturnType<typeof mountPublicRouter>,
  url: string,
): Promise<Response> {
  return app.fetch(new Request(url), { connectionIp: "127.0.0.1" });
}

describe("public routes surface CLI-created agents without restart", () => {
  let db: DbClient;
  let sqlite: Database;
  let registry: AgentRegistry;
  let app: ReturnType<typeof mountPublicRouter>;

  beforeEach(async () => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
    registry = new AgentRegistry(db);
    // Simulate boot: load the (empty) registry, then later seed the DB
    // directly (as `hina cli create-agent` does). Without the sync hooks in
    // the public routes the agent would be invisible until first HELLO.
    await registry.load();
    app = mountPublicRouter(db, registry);
  });

  afterEach(() => sqlite.close());

  test("GET /api/public/agents syncs the registry so CLI-created agents appear", async () => {
    await seedAgent(db, { id: "cli-public", name: "from-cli", isPublic: true });
    // Registry is cold — not insert()'d, not ensureAgent'd.
    expect(registry.has("cli-public")).toBe(false);

    const res = await fetchPublic(app, "http://test/api/public/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ id: string }> };
    expect(body.agents.map((a) => a.id)).toContain("cli-public");

    // Side effect: list handler's syncFromDb pulled the agent in.
    expect(registry.has("cli-public")).toBe(true);
  });

  test("GET /api/public/agents does NOT expose non-public CLI agents", async () => {
    await seedAgent(db, { id: "cli-private", name: "private", isPublic: false });
    const res = await fetchPublic(app, "http://test/api/public/agents");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ id: string }> };
    expect(body.agents.map((a) => a.id)).not.toContain("cli-private");
  });

  test("GET /api/public/agents/:id lazy-loads a CLI-created public agent", async () => {
    await seedAgent(db, { id: "cli-public", name: "from-cli", isPublic: true });
    expect(registry.has("cli-public")).toBe(false);

    const res = await fetchPublic(app, "http://test/api/public/agents/cli-public");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; isPublic: boolean };
    expect(body.id).toBe("cli-public");
    expect(body.isPublic).toBe(true);
  });

  test("GET /api/public/agents/:id 404s for CLI-created private agents (anonymous)", async () => {
    await seedAgent(db, { id: "cli-private", name: "private", isPublic: false });
    const res = await fetchPublic(app, "http://test/api/public/agents/cli-private");
    expect(res.status).toBe(404);
  });

  test("series visibility check recognizes a CLI-created public agent", async () => {
    await seedAgent(db, { id: "cli-public", name: "from-cli", isPublic: true });
    // /series rejects non-existent agents with 404 (via isAgentVisibleInRegistry).
    // A valid from/to must not trip on range validation — the purpose here is
    // to confirm the visibility gate admits the CLI agent.
    const url = new URL("http://test/api/public/agents/cli-public/series");
    url.searchParams.set("from", String(Date.now() - 60_000));
    url.searchParams.set("to", String(Date.now()));
    const res = await fetchPublic(app, url.toString());
    // 200 (no data yet but accepted) — the important thing is it's NOT 404.
    expect(res.status).not.toBe(404);
  });
});
