import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { AgentRegistry } from "../agents/registry";
import type { DbClient } from "../db/client";
import * as schema from "../db/schema";
import { DbWriter } from "../db/writer";
import { createGeoLookup, type GeoLookup } from "../geo/lookup";
import { getMigrationsFolder } from "../paths";
import { sha256Hex } from "../util/hash";
import { handleHello, type HelloHandlerDeps } from "./handle-hello";
import type { AgentWsData } from "./hub";

function createTestDb(): { db: DbClient; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema }) as DbClient;
  migrate(db, { migrationsFolder: getMigrationsFolder() });
  return { db, sqlite };
}

async function seedAgent(db: DbClient, id: string, token: string) {
  const nowMs = Date.now();
  await db.insert(schema.agent).values({
    id,
    tokenHash: sha256Hex(token),
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
  await db.insert(schema.agentBilling).values({
    agentId: id,
    quotaBytes: 0,
    mode: "sum",
    resetDay: 1,
    updatedAtMs: nowMs,
  });
}

function makeFakeWs(transportIp = "127.0.0.1"): ServerWebSocket<AgentWsData> {
  const sent: Uint8Array[] = [];
  const ws = {
    data: {
      kind: "agent",
      transportIp,
      authed: false,
      rateLimit: { tokens: 10, lastMs: 0, strikes: 0, strikeWindowStartMs: 0 },
      probeTaskIds: new Set<string>(),
      tracerouteTaskIds: new Set<string>(),
    } satisfies AgentWsData,
    send(payload: Uint8Array) {
      sent.push(payload);
    },
    close() {},
    readyState: 1,
  } as unknown as ServerWebSocket<AgentWsData> & { _sent: Uint8Array[] };
  (ws as unknown as { _sent: Uint8Array[] })._sent = sent;
  return ws;
}

describe("handleHello defers registry update until DB commit succeeds", () => {
  let db: DbClient;
  let sqlite: Database;
  let registry: AgentRegistry;
  let writer: DbWriter;
  let geoLookup: GeoLookup;
  let deps: HelloHandlerDeps;

  beforeEach(async () => {
    const r = createTestDb();
    db = r.db;
    sqlite = r.sqlite;
    registry = new AgentRegistry(db);
    writer = new DbWriter(db);
    geoLookup = createGeoLookup();
    deps = {
      db,
      writer,
      registry,
      geoLookup,
      connections: new Map(),
      buildRuntimeConfigBody: () => ({ t_ms: 1000, j_ms: 100 }),
      pushProbeConfig: async () => true,
    };
  });

  afterEach(async () => {
    await writer.drain();
    sqlite.close();
  });

  test("registry only reflects HELLO metadata after the writer tx commits", async () => {
    await seedAgent(db, "a1", "tok-a1");
    await registry.load();

    // Baseline — registry has the agent but shows offline (no HELLO yet).
    expect(registry.getSummary("a1")?.status.online).toBe(false);

    const ws = makeFakeWs();
    const helloBody = {
      tok: "tok-a1",
      host: "host-1",
      os: "linux",
      arch: "x86_64",
      ver: "1.0.0",
    };

    await handleHello(ws, helloBody, Date.now(), deps);

    // `handleHello` queues the DB write via DbWriter (a microtask-scheduled
    // batch). The registry apply is chained onto the writer's promise — it
    // hasn't run yet.
    expect(registry.getSummary("a1")?.status.online).toBe(false);

    // Drain the writer so the batch commits + the `.then()` callback runs.
    await writer.drain();

    const after = registry.getAdminDetail("a1");
    expect(after?.status.online).toBe(true);
    expect(after?.system.host).toBe("host-1");
    expect(after?.system.os).toBe("linux");
  });

  test("registry remains unchanged when the writer tx rolls back", async () => {
    await seedAgent(db, "a1", "tok-a1");
    await registry.load();

    // Swap in a writer whose enqueue always rejects, simulating a rolled-
    // back batch (a sibling task throwing during the shared tx). The real
    // DbWriter rejects every task in a failing batch, so this is the same
    // promise shape handleHello sees in production.
    const failingWriter = {
      enqueue: () => Promise.reject(new Error("batch rolled back")),
      drain: async () => {},
    } as unknown as DbWriter;
    const deps2: HelloHandlerDeps = { ...deps, writer: failingWriter };

    const ws = makeFakeWs();
    const helloBody = {
      tok: "tok-a1",
      host: "host-1",
      os: "linux",
      arch: "x86_64",
      ver: "1.0.0",
    };

    await handleHello(ws, helloBody, Date.now(), deps2);
    // Let the rejected promise's `.catch` (inside enqueueOrLog) flush.
    await new Promise((r) => setTimeout(r, 5));

    // DB: still at seed state — nothing was written.
    const [row] = await db
      .select({ online: schema.agentStatus.online, lastHost: schema.agentStatus.lastHost })
      .from(schema.agentStatus)
      .where(eq(schema.agentStatus.agentId, "a1"));
    expect(row?.online).toBe(false);
    expect(row?.lastHost).toBeNull();

    // Registry: not touched — the .then() never fired because the writer
    // rejected.
    const summary = registry.getSummary("a1");
    expect(summary?.status.online).toBe(false);
    expect(registry.getAdminDetail("a1")?.system.host).toBeNull();
  });

  test("geo lookup prefers HELLO reported public IP over CDN transport IP", async () => {
    await seedAgent(db, "a1", "tok-a1");
    await registry.load();

    const geoIps: string[] = [];
    const geoLookupStub: GeoLookup = {
      lookupGeo: async () => null,
      resolveAgentGeo: async (_db, _agentId, ip) => {
        geoIps.push(ip);
        return null;
      },
      clearAgentGeoState: () => {},
    };

    const ws = makeFakeWs("104.16.0.1");
    const helloBody = {
      tok: "tok-a1",
      ip4: "8.8.8.8",
      ip6: "2001:4860:4860::8888",
    };

    await handleHello(ws, helloBody, Date.now(), { ...deps, geoLookup: geoLookupStub });

    expect(geoIps).toEqual(["8.8.8.8"]);
  });
});
