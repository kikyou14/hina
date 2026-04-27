import { encode } from "@msgpack/msgpack";
import type { ServerWebSocket } from "bun";
import { eq } from "drizzle-orm";
import type { AgentRegistry } from "../agents/registry";
import type { DbClient } from "../db/client";
import { agent as agentTable } from "../db/schema";
import type { DbWriter } from "../db/writer";
import type { GeoLookup } from "../geo/lookup";
import { upsertAgentHelloState } from "../ingest/status";
import type { BrowserLiveHub } from "../live/hub";
import { createLogger } from "../logging/logger";
import { MessageType, encodeEnvelope, encodeError, parseHelloBody } from "../protocol/envelope";
import { sha256Hex } from "../util/hash";
import { resolveAgentIpFamilies, selectAgentGeoIp } from "../util/ip";
import { safeJsonStringify } from "../util/lang";
import { resolveAndPublishAgentGeo } from "./geo";
import type { AgentWsData } from "./hub";
import { enqueueOrLog, normalizeOptionalString, sendAndClose } from "./util";

const wsLog = createLogger("ws");

export type RuntimeConfigBody = {
  t_ms: number;
  j_ms: number;
};

export type HelloHandlerDeps = {
  db: DbClient;
  writer: DbWriter;
  liveHub?: BrowserLiveHub;
  registry: AgentRegistry;
  geoLookup: GeoLookup;
  connections: Map<string, ServerWebSocket<AgentWsData>>;
  buildRuntimeConfigBody: () => RuntimeConfigBody;
  pushProbeConfig: (agentId: string) => Promise<boolean>;
};

export async function handleHello(
  ws: ServerWebSocket<AgentWsData>,
  envelopeBody: unknown,
  nowMs: number,
  deps: HelloHandlerDeps,
): Promise<void> {
  try {
    await handleHelloInner(ws, envelopeBody, nowMs, deps);
  } catch (err) {
    wsLog.error("handleHello failed", err);
    try {
      sendAndClose(ws, encodeError("internal", "Internal error"), 1011, "internal");
    } catch (closeErr) {
      wsLog.warn("sendAndClose failed after handleHello error", closeErr);
    }
  }
}

async function handleHelloInner(
  ws: ServerWebSocket<AgentWsData>,
  envelopeBody: unknown,
  nowMs: number,
  deps: HelloHandlerDeps,
): Promise<void> {
  const hello = parseHelloBody(envelopeBody);
  if (!hello) {
    sendAndClose(ws, encodeError("bad_hello", "Invalid HELLO body"), 4002, "bad_hello");
    return;
  }

  const tokenHash = sha256Hex(hello.tok);
  const rows = await deps.db
    .select({ id: agentTable.id })
    .from(agentTable)
    .where(eq(agentTable.tokenHash, tokenHash))
    .limit(1);

  if (rows.length === 0) {
    sendAndClose(ws, encodeError("unauthorized", "Invalid token"), 4001, "unauthorized");
    return;
  }

  const agentId = rows[0]!.id;

  const known = await deps.registry.ensureAgent(agentId);
  if (!known) {
    sendAndClose(ws, encodeError("unauthorized", "Invalid token"), 4001, "unauthorized");
    return;
  }

  ws.data.authed = true;
  ws.data.agentId = agentId;
  ws.data.probeTaskIds = new Set();
  ws.data.tracerouteTaskIds = new Set();
  if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);

  const prev = deps.connections.get(agentId);
  if (prev && prev !== ws) {
    try {
      prev.close(4000, "replaced");
    } catch (err) {
      wsLog.warn(`prev.close failed on replace: id=${agentId}`, err);
    }
  }
  deps.connections.set(agentId, ws);

  const ip = ws.data.transportIp ?? "unknown";
  wsLog.info(`agent ${prev && prev !== ws ? "reconnected" : "connected"}: id=${agentId} ip=${ip}`);

  const inventoryPack = hello.inv !== undefined ? Buffer.from(encode(hello.inv)) : undefined;
  const capabilitiesJson = safeJsonStringify(hello.cap) ?? null;
  const resolvedIps = resolveAgentIpFamilies({
    reportedIpv4: hello.ip4 ?? null,
    reportedIpv6: hello.ip6 ?? null,
    transportIp: ws.data.transportIp ?? null,
  });
  ws.data.ipV4 = resolvedIps.ipv4;
  ws.data.ipV6 = resolvedIps.ipv6;

  const ipV4 = resolvedIps.ipv4;
  const ipV6 = resolvedIps.ipv6;

  const host = normalizeOptionalString(hello.host);
  const os = normalizeOptionalString(hello.os);
  const arch = normalizeOptionalString(hello.arch);
  const agentVersion = normalizeOptionalString(hello.ver);

  enqueueOrLog(
    deps.writer
      .enqueue((tx) =>
        upsertAgentHelloState(tx, {
          agentId,
          ipV4,
          ipV6,
          host,
          os,
          arch,
          agentVersion,
          capabilitiesJson,
          inventoryPack,
          tsMs: nowMs,
        }),
      )
      .then(() => {
        deps.registry.applyHello(agentId, {
          tsMs: nowMs,
          host,
          os,
          arch,
          agentVersion,
          capabilities: hello.cap,
          inventory: hello.inv,
          ipV4,
          ipV6,
        });
        deps.liveHub?.publishAgentPresence([
          {
            agentId,
            online: true,
            lastSeenAtMs: nowMs,
            lastIpV4: ipV4,
            lastIpV6: ipV6,
          },
        ]);
      }),
  );

  const transportIp = ws.data.transportIp ?? null;
  const geoIp = selectAgentGeoIp({
    reportedIpv4: hello.ip4 ?? null,
    reportedIpv6: hello.ip6 ?? null,
    transportIp,
  });
  if (geoIp) {
    resolveAndPublishAgentGeo({
      db: deps.db,
      registry: deps.registry,
      liveHub: deps.liveHub,
      geoLookup: deps.geoLookup,
      agentId,
      ip: geoIp,
    });
  }

  ws.send(
    encodeEnvelope(MessageType.Welcome, {
      aid: agentId,
      stm: nowMs,
      cfg: deps.buildRuntimeConfigBody(),
    }),
  );

  void deps.pushProbeConfig(agentId);
}
