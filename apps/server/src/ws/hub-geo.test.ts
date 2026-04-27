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
import { createWsHub, type AgentWsData } from "./hub";

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

describe("agent geo updates", () => {
  test("IP_UPDATE geo lookup prefers reported public IP over CDN transport IP", async () => {
    const { db, sqlite } = createTestDb();
    let stop: (() => Promise<void>) | null = null;

    try {
      await seedAgent(db, "a1");
      const registry = new AgentRegistry(db);
      await registry.load();

      const geoIps: string[] = [];
      const geoLookup: GeoLookup = {
        lookupGeo: async () => null,
        resolveAgentGeo: async (_db, _agentId, ip) => {
          geoIps.push(ip);
          return null;
        },
        clearAgentGeoState: () => {},
      };
      const runtimeAgentConfig = new RuntimeAgentConfigStore({
        current: RUNTIME_AGENT_DEFAULTS,
        source: {
          telemetryIntervalMs: "default",
          telemetryJitterMs: "default",
        },
      });
      const hub = createWsHub({
        db,
        registry,
        runtimeAgentConfig,
        geoLookup,
        asnLookup: null,
      });
      stop = hub.stop;

      const ws = makeAuthedWs("a1", "104.16.0.1");
      const message = encodeEnvelope(MessageType.IpUpdate, {
        ip4: "8.8.8.8",
        ip6: "2001:4860:4860::8888",
      });

      await Promise.resolve(hub.websocket.message(ws, message));

      expect(geoIps).toEqual(["8.8.8.8"]);
    } finally {
      await stop?.();
      sqlite.close();
    }
  });
});
