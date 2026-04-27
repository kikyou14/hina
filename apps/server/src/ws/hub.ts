import type { Server, ServerWebSocket } from "bun";
import type { AgentRegistry } from "../agents/registry";
import { ingestRouteChangeEvents } from "../alert";
import { WS_HELLO_TIMEOUT_MS } from "../config";
import type { DbClient } from "../db/client";
import { DbWriter } from "../db/writer";
import type { AsnLookup } from "../geo/asn";
import type { GeoLookup } from "../geo/lookup";
import { markAgentOffline, updateAgentIps } from "../ingest/status";
import type { BrowserLiveHub } from "../live/hub";
import { createLogger } from "../logging/logger";
import {
  MessageType,
  decodeEnvelope,
  encodeEnvelope,
  encodeError,
  parseIpUpdateBody,
  parseProbeResultBody,
  parseTelemetryBody,
} from "../protocol/envelope";
import type { RuntimeAgentConfigStore } from "../settings/runtime";
import { resolveAgentIpFamilies, selectAgentGeoIp } from "../util/ip";
import { resolveClientIp } from "../util/trust-proxy";
import { FlushBuffer } from "./flush-buffer";
import { resolveAndPublishAgentGeo } from "./geo";
import { handleHello, type RuntimeConfigBody } from "./handle-hello";
import {
  buildProbeConfigForAgent,
  fetchAgentProbeScope,
  fetchAgentProbeScopes,
  fetchAllAgentTasks,
  type AgentProbeScope,
} from "./probe-config";
import { enqueueOrLog, sendAndClose } from "./util";

const wsLog = createLogger("ws");

const AGENT_MSG_REFILL_PER_SEC = 5;
const AGENT_MSG_BURST = 10;
const AGENT_MSG_STRIKE_WINDOW_MS = 60_000;
const AGENT_MSG_MAX_STRIKES = 5;

const DB_PROBE_BUFFER_MAX = 10_000;
const DB_PROBE_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
const DB_FLUSH_INTERVAL_MS = 1000;

type RateLimitState = {
  tokens: number;
  lastMs: number;
  strikes: number;
  strikeWindowStartMs: number;
};

export type AgentWsData = {
  kind: "agent";
  transportIp?: string;
  ipV4?: string | null;
  ipV6?: string | null;
  agentId?: string;
  probeTaskIds?: Set<string>;
  tracerouteTaskIds?: Set<string>;
  authed: boolean;
  rateLimit: RateLimitState;
  helloTimer?: ReturnType<typeof setTimeout>;
};

export type ProbeDispatcher = {
  pushAll: () => Promise<number>;
  pushAgent: (agentId: string) => Promise<boolean>;
  pushGroup: (groupId: string) => Promise<number>;
  pushRuntimeConfigAll: () => Promise<number>;
  pushRuntimeConfigAgent: (agentId: string) => Promise<boolean>;
  revokeAgent: (agentId: string) => Promise<boolean>;
  quiesceAgent: (agentId: string) => Promise<void>;
};

export type WsHub = {
  handleUpgrade: (req: Request, server: Server<AgentWsData>) => Response | undefined;
  websocket: {
    open: (ws: ServerWebSocket<AgentWsData>) => void;
    message: (ws: ServerWebSocket<AgentWsData>, message: string | Uint8Array) => void;
    close: (ws: ServerWebSocket<AgentWsData>) => void;
  };
  probeDispatcher: ProbeDispatcher;
  // Stop the flush timer and drain buffered writes. Idempotent.
  stop: () => Promise<void>;
};

function shouldAcceptMessage(ws: ServerWebSocket<AgentWsData>, nowMs: number): boolean {
  const rl = ws.data.rateLimit;

  const elapsedSec = Math.max(0, (nowMs - rl.lastMs) / 1000);
  rl.tokens = Math.min(AGENT_MSG_BURST, rl.tokens + elapsedSec * AGENT_MSG_REFILL_PER_SEC);
  rl.lastMs = nowMs;

  if (rl.tokens >= 1) {
    rl.tokens -= 1;
    return true;
  }

  if (nowMs - rl.strikeWindowStartMs >= AGENT_MSG_STRIKE_WINDOW_MS) {
    rl.strikeWindowStartMs = nowMs;
    rl.strikes = 0;
  }
  rl.strikes += 1;

  if (rl.strikes >= AGENT_MSG_MAX_STRIKES) {
    wsLog.warn(`agent rate-limited: id=${ws.data.agentId ?? "unknown"}`);
    try {
      ws.close(1008, "Rate limit exceeded");
    } catch (err) {
      wsLog.warn(`ws.close failed on rate-limit: id=${ws.data.agentId ?? "unknown"}`, err);
    }
  }

  return false;
}

export function createWsHub(deps: {
  db: DbClient;
  liveHub?: BrowserLiveHub;
  registry: AgentRegistry;
  runtimeAgentConfig: RuntimeAgentConfigStore;
  geoLookup: GeoLookup;
  asnLookup: AsnLookup | null;
}): WsHub {
  const writer = new DbWriter(deps.db);
  const connections = new Map<string, ServerWebSocket<AgentWsData>>();
  let lastProbeConfigRev = 0;

  const flushBuffer = new FlushBuffer(
    {
      db: deps.db,
      liveHub: deps.liveHub,
      registry: deps.registry,
      asnLookup: deps.asnLookup,
      isAgentConnected: (agentId) => connections.has(agentId),
      onRouteChanges: (changes) => {
        ingestRouteChangeEvents(deps.db, changes).catch((err) => {
          wsLog.error("route change alert dispatch failed", err);
        });
      },
    },
    {
      maxProbeEntries: DB_PROBE_BUFFER_MAX,
      maxProbeBytes: DB_PROBE_BUFFER_MAX_BYTES,
      flushIntervalMs: DB_FLUSH_INTERVAL_MS,
    },
  );
  flushBuffer.start();

  function buildRuntimeConfigBody(): RuntimeConfigBody {
    const current = deps.runtimeAgentConfig.getCurrent();
    return {
      t_ms: current.telemetryIntervalMs,
      j_ms: current.telemetryJitterMs,
    };
  }

  function nextProbeConfigRev(nowMs = Date.now()): number {
    lastProbeConfigRev = Math.max(nowMs, lastProbeConfigRev + 1);
    return lastProbeConfigRev;
  }

  function scopeFromPrefetch(
    scopes: Map<string, AgentProbeScope> | undefined,
    agentId: string,
  ): AgentProbeScope | null | undefined {
    if (!scopes) return undefined;
    return scopes.get(agentId) ?? null;
  }

  async function pushProbeConfig(
    agentId: string,
    options: {
      allAgentTasks?: Awaited<ReturnType<typeof fetchAllAgentTasks>>;
      scope?: AgentProbeScope | null;
    } = {},
  ): Promise<boolean> {
    const ws = connections.get(agentId);
    if (!ws || !ws.data.authed) return false;

    try {
      const scope =
        options.scope === undefined ? await fetchAgentProbeScope(deps.db, agentId) : options.scope;
      if (!scope) return false;
      const body = await buildProbeConfigForAgent(deps.db, agentId, {
        allAgentTasks: options.allAgentTasks,
        scope,
        rev: nextProbeConfigRev(),
      });
      ws.data.probeTaskIds = new Set(body.tasks.map((t) => t.id));
      ws.data.tracerouteTaskIds = new Set(
        body.tasks.filter((t) => t.k === "traceroute").map((t) => t.id),
      );
      ws.send(encodeEnvelope(MessageType.ProbeConfig, body));
      return true;
    } catch (err) {
      wsLog.error(`push probe config failed: agent=${agentId}`, err);
      return false;
    }
  }

  async function pushRuntimeConfig(agentId: string): Promise<boolean> {
    const ws = connections.get(agentId);
    if (!ws || !ws.data.authed) return false;
    try {
      ws.send(
        encodeEnvelope(MessageType.Welcome, {
          aid: agentId,
          stm: Date.now(),
          cfg: buildRuntimeConfigBody(),
        }),
      );
      return true;
    } catch (err) {
      wsLog.error(`push runtime config failed: agent=${agentId}`, err);
      return false;
    }
  }

  async function revokeAgent(agentId: string): Promise<boolean> {
    const ws = connections.get(agentId);
    if (ws) {
      ws.data.authed = false;
    }
    connections.delete(agentId);

    flushBuffer.removeAgent(agentId);
    deps.geoLookup.clearAgentGeoState(agentId);

    wsLog.info(`agent revoked: id=${agentId} wasConnected=${ws !== undefined}`);
    if (ws) {
      try {
        ws.close(4003, "revoked");
      } catch (err) {
        wsLog.warn(`ws.close failed on revoke: id=${agentId}`, err);
      }
    }
    return ws !== undefined;
  }

  const probeDispatcher: ProbeDispatcher = {
    async pushAgent(agentId) {
      return pushProbeConfig(agentId);
    },

    async pushGroup(groupId) {
      const onlineAgentIds = [...connections.keys()];
      const scopes = await fetchAgentProbeScopes(deps.db, onlineAgentIds).catch((err) => {
        wsLog.error(`push probe group config failed: group=${groupId}`, err);
        return null;
      });
      if (!scopes) return 0;
      const targets = onlineAgentIds.filter((agentId) => scopes.get(agentId)?.groupId === groupId);
      const allAgentTasks = await fetchAllAgentTasks(deps.db).catch(() => undefined);
      let pushed = 0;
      for (const agentId of targets) {
        if (
          await pushProbeConfig(agentId, {
            allAgentTasks,
            scope: scopeFromPrefetch(scopes, agentId),
          })
        ) {
          pushed += 1;
        }
      }
      return pushed;
    },

    async pushAll() {
      const allAgentTasks = await fetchAllAgentTasks(deps.db).catch(() => undefined);
      const targets = [...connections.keys()];
      const scopes = await fetchAgentProbeScopes(deps.db, targets).catch(() => undefined);
      let pushed = 0;
      for (const agentId of targets) {
        if (
          await pushProbeConfig(agentId, {
            allAgentTasks,
            scope: scopeFromPrefetch(scopes, agentId),
          })
        ) {
          pushed += 1;
        }
      }
      return pushed;
    },

    async pushRuntimeConfigAgent(agentId) {
      return pushRuntimeConfig(agentId);
    },

    async pushRuntimeConfigAll() {
      const targets = [...connections.keys()];
      let pushed = 0;
      for (const agentId of targets) {
        if (await pushRuntimeConfig(agentId)) pushed += 1;
      }
      return pushed;
    },

    async revokeAgent(agentId) {
      return revokeAgent(agentId);
    },

    async quiesceAgent(agentId) {
      await revokeAgent(agentId);
      await flushBuffer.awaitInflight();
    },
  };

  const handleUpgrade: WsHub["handleUpgrade"] = (req, server) => {
    const ip = resolveClientIp(req, server.requestIP(req)?.address);
    const nowMs = Date.now();
    const ok = server.upgrade(req, {
      data: {
        kind: "agent",
        transportIp: ip,
        authed: false,
        rateLimit: {
          tokens: AGENT_MSG_BURST,
          lastMs: nowMs,
          strikes: 0,
          strikeWindowStartMs: nowMs,
        },
      } satisfies AgentWsData,
    });
    if (!ok) return new Response("Upgrade required", { status: 426 });
    return undefined;
  };

  const websocket: WsHub["websocket"] = {
    open(ws) {
      ws.data.authed = false;
      ws.data.rateLimit.tokens = AGENT_MSG_BURST;
      ws.data.rateLimit.lastMs = Date.now();
      ws.data.rateLimit.strikes = 0;
      ws.data.rateLimit.strikeWindowStartMs = ws.data.rateLimit.lastMs;
      ws.data.helloTimer = setTimeout(() => {
        if (!ws.data.authed) ws.close(4001, "hello_timeout");
      }, WS_HELLO_TIMEOUT_MS);
    },

    async message(ws, message) {
      try {
        if (typeof message === "string") {
          sendAndClose(
            ws,
            encodeError("bad_message", "Binary MessagePack required"),
            4002,
            "bad_message",
          );
          return;
        }

        const messageSize = message.byteLength;
        const nowMs = Date.now();
        if (!shouldAcceptMessage(ws, nowMs)) return;

        const envelope = decodeEnvelope(message);
        if (!envelope || envelope.v !== 1) {
          sendAndClose(ws, encodeError("bad_envelope", "Invalid envelope"), 4002, "bad_envelope");
          return;
        }

        if (!ws.data.authed) {
          if (envelope.t !== MessageType.Hello) {
            sendAndClose(ws, encodeError("unauthorized", "HELLO required"), 4001, "unauthorized");
            return;
          }

          await handleHello(ws, envelope.b, nowMs, {
            db: deps.db,
            writer,
            liveHub: deps.liveHub,
            registry: deps.registry,
            geoLookup: deps.geoLookup,
            connections,
            buildRuntimeConfigBody,
            pushProbeConfig,
          });
          return;
        }

        const agentId = ws.data.agentId;
        if (!agentId) {
          sendAndClose(
            ws,
            encodeError("unauthorized", "Missing agent context"),
            4001,
            "unauthorized",
          );
          return;
        }
        if (envelope.t === MessageType.Telemetry) {
          const telemetry = parseTelemetryBody(envelope.b);
          if (!telemetry) return;

          flushBuffer.enqueueTelemetry({
            agentId,
            recvTsMs: nowMs,
            seq: telemetry.seq,
            uptimeSec: telemetry.up_s ?? null,
            rxBytesTotal: telemetry.rx,
            txBytesTotal: telemetry.tx,
            latestTelemetryPack: Buffer.from(message),
            numericMetrics: telemetry.m,
          });
          return;
        }

        if (envelope.t === MessageType.IpUpdate) {
          const ipUpdate = parseIpUpdateBody(envelope.b);
          if (!ipUpdate) return;

          const resolvedIps = resolveAgentIpFamilies({
            reportedIpv4: ipUpdate.ip4 ?? null,
            reportedIpv6: ipUpdate.ip6 ?? null,
            transportIp: ws.data.transportIp ?? null,
          });
          ws.data.ipV4 = resolvedIps.ipv4;
          ws.data.ipV6 = resolvedIps.ipv6;

          enqueueOrLog(
            writer
              .enqueue((tx) =>
                updateAgentIps(tx, agentId, resolvedIps.ipv4, resolvedIps.ipv6, nowMs),
              )
              .then(() => {
                deps.registry.applyIpUpdate(agentId, {
                  tsMs: nowMs,
                  ipV4: resolvedIps.ipv4,
                  ipV6: resolvedIps.ipv6,
                });
                deps.liveHub?.publishAgentPresence([
                  {
                    agentId,
                    online: true,
                    lastSeenAtMs: nowMs,
                    lastIpV4: resolvedIps.ipv4,
                    lastIpV6: resolvedIps.ipv6,
                  },
                ]);
              }),
          );

          const geoIp = selectAgentGeoIp({
            reportedIpv4: ipUpdate.ip4 ?? null,
            reportedIpv6: ipUpdate.ip6 ?? null,
            transportIp: ws.data.transportIp ?? null,
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
          return;
        }

        if (envelope.t === MessageType.ProbeResult) {
          const result = parseProbeResultBody(envelope.b, nowMs);
          if (!result) return;

          const allowed = ws.data.probeTaskIds;
          if (allowed && !allowed.has(result.tid)) return;

          flushBuffer.enqueueProbeResult({
            bytes: messageSize,
            args: { agentId, recvTsMs: nowMs, result },
            isTraceroute: ws.data.tracerouteTaskIds?.has(result.tid) ?? false,
          });
          return;
        }
      } catch (err) {
        wsLog.error(`agent message handler failed: id=${ws.data.agentId ?? "unknown"}`, err);
        try {
          ws.close(1011, "internal_error");
        } catch {}
      }
    },

    close(ws) {
      if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
      if (!ws.data.agentId) return;
      const nowMs = Date.now();
      const agentId = ws.data.agentId;
      const current = connections.get(agentId);
      if (current !== ws) return;

      deps.geoLookup.clearAgentGeoState(agentId);
      connections.delete(agentId);
      wsLog.info(`agent disconnected: id=${agentId}`);

      const lastIpV4 = ws.data.ipV4 ?? null;
      const lastIpV6 = ws.data.ipV6 ?? null;

      enqueueOrLog(
        writer
          .enqueue((tx) => markAgentOffline(tx, agentId, nowMs))
          .then(() => {
            deps.registry.markOffline(agentId, nowMs);
            deps.liveHub?.publishAgentPresence([
              {
                agentId,
                online: false,
                lastSeenAtMs: nowMs,
                lastIpV4,
                lastIpV6,
              },
            ]);
          }),
      );
    },
  };

  async function stop(): Promise<void> {
    await flushBuffer.stop();
    await writer.drain();
  }

  return { handleUpgrade, websocket, probeDispatcher, stop };
}
