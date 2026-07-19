import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { AgentRegistry } from "../agents/registry";
import type { DbClient } from "../db/client";
import * as schema from "../db/schema";
import type { GeoLookup } from "../geo/lookup";
import { getMigrationsFolder } from "../paths";
import { encodeEnvelope, MessageType } from "../protocol/envelope";
import { RUNTIME_AGENT_DEFAULTS, RuntimeAgentConfigStore } from "../settings/runtime";
import { sha256Hex } from "../util/hash";
import { createWsHub, type AgentWsData, type WsHub } from "./hub";

function createTestDb(): { db: DbClient; sqlite: Database } {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema }) as DbClient;
  migrate(db, { migrationsFolder: getMigrationsFolder() });
  return { db, sqlite };
}

async function seedAgent(db: DbClient, id: string) {
  const nowMs = Date.now();
  await db.insert(schema.agent).values({
    id,
    tokenHash: sha256Hex(`token-${id}`),
    name: id,
    isPublic: true,
    displayOrder: 0,
    tagsJson: "[]",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  await db.insert(schema.agentStatus).values({
    agentId: id,
    online: true,
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

function makeAuthedWs(agentId: string, transportIp: string): ServerWebSocket<AgentWsData> {
  return {
    data: {
      kind: "agent",
      transportIp,
      authed: true,
      agentId,
      rateLimit: {
        tokens: 10,
        lastMs: Date.now(),
        strikes: 0,
        strikeWindowStartMs: Date.now(),
      },
    } satisfies AgentWsData,
    send() {},
    close() {},
    readyState: 1,
  } as unknown as ServerWebSocket<AgentWsData>;
}

async function makeHub(geoLookup: GeoLookup): Promise<{
  hub: WsHub;
  sqlite: Database;
}> {
  const { db, sqlite } = createTestDb();
  await seedAgent(db, "a1");

  const registry = new AgentRegistry(db);
  await registry.load();
  const runtimeAgentConfig = new RuntimeAgentConfigStore({
    current: RUNTIME_AGENT_DEFAULTS,
    source: {
      telemetryIntervalMs: "default",
      telemetryJitterMs: "default",
    },
  });

  return {
    hub: createWsHub({
      db,
      registry,
      runtimeAgentConfig,
      geoLookup,
      asnLookup: null,
    }),
    sqlite,
  };
}

describe("agent geo updates", () => {
  test("IP_UPDATE geo lookup prefers reported public IP over CDN transport IP", async () => {
    const geoIps: string[] = [];
    const { hub, sqlite } = await makeHub({
      lookupGeo: async () => null,
      resolveAgentGeo: async (_db, _agentId, ip) => {
        geoIps.push(ip);
        return null;
      },
      clearAgentGeoState: () => {},
    });

    try {
      const ws = makeAuthedWs("a1", "104.16.0.1");
      const message = encodeEnvelope(MessageType.IpUpdate, {
        ip4: "8.8.8.8",
        ip6: "2001:4860:4860::8888",
      });

      await hub.websocket.message(ws, message);

      expect(geoIps).toEqual(["8.8.8.8"]);
    } finally {
      await hub.stop();
      sqlite.close();
    }
  });

  test("ignores messages after quiescing", async () => {
    const geoIps: string[] = [];
    const { hub, sqlite } = await makeHub({
      lookupGeo: async () => null,
      resolveAgentGeo: async (_db, _agentId, ip) => {
        geoIps.push(ip);
        return null;
      },
      clearAgentGeoState: () => {},
    });

    try {
      hub.quiesce();
      const ws = makeAuthedWs("a1", "104.16.0.1");
      const message = encodeEnvelope(MessageType.IpUpdate, { ip4: "8.8.8.8" });

      await hub.websocket.message(ws, message);

      expect(geoIps).toEqual([]);
    } finally {
      await hub.stop();
      sqlite.close();
    }
  });

  test("waits for tracked background work before stopping", async () => {
    let finishGeo!: () => void;
    const geoFinished = new Promise<null>((resolve) => {
      finishGeo = () => resolve(null);
    });
    const { hub, sqlite } = await makeHub({
      lookupGeo: async () => null,
      resolveAgentGeo: () => geoFinished,
      clearAgentGeoState: () => {},
    });

    try {
      const ws = makeAuthedWs("a1", "104.16.0.1");
      const message = encodeEnvelope(MessageType.IpUpdate, { ip4: "8.8.8.8" });
      await hub.websocket.message(ws, message);

      let stopped = false;
      const stop = hub.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);

      finishGeo();
      await stop;
      expect(stopped).toBe(true);
    } finally {
      await hub.stop();
      sqlite.close();
    }
  });
});
