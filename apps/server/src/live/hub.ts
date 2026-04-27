import type { Server, ServerWebSocket } from "bun";
import type { AgentPublicSummary, AgentRegistry } from "../agents/registry";
import { SESSION_COOKIE_NAME, findValidSession, hashSessionToken } from "../auth/session";
import type { DbClient } from "../db/client";
import type { ProbeResultIngestArgs } from "../ingest/probe";
import type { TelemetryIngestArgs, TelemetryIngestResult } from "../ingest/telemetry";
import { createLogger } from "../logging/logger";
import { uniqueStrings } from "../util/lang";
import { checkRequestOrigin } from "../util/origin";

const liveLog = createLogger("live");

function getCookieValue(header: string | null, key: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name !== key) continue;
    const raw = part.slice(idx + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function sendJson(ws: ServerWebSocket<BrowserLiveWsData>, payload: unknown) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {}
}

function sendRaw(ws: ServerWebSocket<BrowserLiveWsData>, raw: string) {
  try {
    ws.send(raw);
  } catch {}
}

export type BrowserLiveWsData = {
  kind: "live";
  scope: "public" | "privileged" | "admin";
  userId?: string;
  sessionTokenHash?: string;
};

type PublicLiveMessage =
  | { type: "hello.public"; tsMs: number }
  | { type: "snapshot.public.agents"; agents: AgentPublicSummary[] }
  | { type: "event.public.agent_upsert"; agent: AgentPublicSummary }
  | { type: "event.public.agent_remove"; agentId: string }
  | {
      type: "event.public.telemetry_delta";
      agentId: string;
      tsMs: number;
      metrics: Record<string, number>;
      deltaRx: number;
      deltaTx: number;
    };

type AdminLiveMessage =
  | { type: "hello.admin"; tsMs: number }
  | {
      type: "event.admin.agent_delta";
      agentId: string;
      status: {
        online: boolean;
        lastSeenAtMs: number | null;
        lastIpV4?: string | null;
        lastIpV6?: string | null;
      };
      latest?: {
        seq: number;
        rx: number;
        tx: number;
        m: Record<string, unknown>;
      } | null;
    }
  | {
      type: "event.admin.agent_geo";
      agentId: string;
      geo: {
        countryCode: string;
        country: string;
        source: string;
      };
    }
  | {
      type: "event.admin.probe_latest";
      agentId: string;
      taskId: string;
      latest: {
        tsMs: number;
        recvTsMs: number;
        ok: boolean;
        latMs: number | null;
        code: number | null;
        err: string | null;
        extra: unknown | null;
        lossPct: number | null;
        jitterMs: number | null;
        updatedAtMs: number;
      };
    };

export type BrowserLiveHub = {
  handlePublicUpgrade: (
    req: Request,
    server: Server<BrowserLiveWsData>,
  ) => Promise<Response | undefined>;
  handleAdminUpgrade: (
    req: Request,
    server: Server<BrowserLiveWsData>,
  ) => Promise<Response | undefined>;
  websocket: {
    open: (ws: ServerWebSocket<BrowserLiveWsData>) => void;
    message: (ws: ServerWebSocket<BrowserLiveWsData>, message: string | Uint8Array) => void;
    close: (ws: ServerWebSocket<BrowserLiveWsData>) => void;
  };

  publishAgentChanges: (agentIds: string[]) => void;
  publishAdminGeo: (
    agentId: string,
    geo: { countryCode: string; country: string; source: string },
  ) => void;
  publishTelemetryBatch: (
    batch: Array<{ args: TelemetryIngestArgs; result: TelemetryIngestResult }>,
  ) => void;
  publishAgentPresence: (
    updates: Array<{
      agentId: string;
      online: boolean;
      lastSeenAtMs: number | null;
      lastIpV4?: string | null;
      lastIpV6?: string | null;
    }>,
  ) => void;
  publishProbeLatestBatch: (batch: ProbeResultIngestArgs[]) => void;

  revalidateActiveSessions: (check: SessionValidityChecker) => Promise<number>;
  disconnectBySession: (tokenHash: string) => void;
  disconnectByUser: (userId: string) => void;
};

export type SessionValidityChecker = (tokenHashes: string[]) => Promise<Set<string>>;

function deduplicateByLatest(
  batch: Array<{ args: TelemetryIngestArgs; result: TelemetryIngestResult }>,
): Map<string, { args: TelemetryIngestArgs; result: TelemetryIngestResult }> {
  const latestByAgentId = new Map<
    string,
    { args: TelemetryIngestArgs; result: TelemetryIngestResult }
  >();
  for (const entry of batch) {
    const existing = latestByAgentId.get(entry.args.agentId);
    if (!existing || entry.args.recvTsMs >= existing.args.recvTsMs) {
      latestByAgentId.set(entry.args.agentId, entry);
    }
  }
  return latestByAgentId;
}

type PublicScopeConfig = {
  clients: Set<ServerWebSocket<BrowserLiveWsData>>;
  onlyPublic: boolean;
  knownIdsMap: WeakMap<ServerWebSocket<BrowserLiveWsData>, Set<string>>;
};

async function sendScopeSnapshot(
  registry: AgentRegistry,
  ws: ServerWebSocket<BrowserLiveWsData>,
  scope: PublicScopeConfig,
) {
  try {
    await registry.syncFromDb();
    if (!scope.clients.has(ws)) return;
    const agents = scope.onlyPublic ? registry.listPublicSummaries() : registry.listSummaries();
    scope.knownIdsMap.set(ws, new Set(agents.map((a) => a.id)));
    sendJson(ws, { type: "snapshot.public.agents", agents } satisfies PublicLiveMessage);
  } catch (err) {
    liveLog.warn(`initial snapshot failed: scope=${ws.data.scope}`, err);
  }
}

function broadcastAgentChangesToScope(
  registry: AgentRegistry,
  scope: PublicScopeConfig,
  uniqueIds: string[],
  nowMs: number,
) {
  if (scope.clients.size === 0 || uniqueIds.length === 0) return;

  const upsertPayloads: Array<[string, string]> = [];
  const hiddenIds: string[] = [];
  for (const id of uniqueIds) {
    const summary = registry.getSummary(id, nowMs);
    if (!summary || (scope.onlyPublic && !summary.isPublic)) {
      hiddenIds.push(id);
      continue;
    }
    upsertPayloads.push([
      summary.id,
      JSON.stringify({
        type: "event.public.agent_upsert",
        agent: summary,
      } satisfies PublicLiveMessage),
    ]);
  }

  const removePayloadCache = new Map<string, string>();
  function getRemovePayload(id: string): string {
    let raw = removePayloadCache.get(id);
    if (raw === undefined) {
      raw = JSON.stringify({
        type: "event.public.agent_remove",
        agentId: id,
      } satisfies PublicLiveMessage);
      removePayloadCache.set(id, raw);
    }
    return raw;
  }

  for (const ws of scope.clients) {
    let knownIds = scope.knownIdsMap.get(ws);
    if (!knownIds) {
      knownIds = new Set();
      scope.knownIdsMap.set(ws, knownIds);
    }
    for (const [id, raw] of upsertPayloads) {
      sendRaw(ws, raw);
      knownIds.add(id);
    }
    for (const id of hiddenIds) {
      if (!knownIds.has(id)) continue;
      sendRaw(ws, getRemovePayload(id));
      knownIds.delete(id);
    }
  }
}

export function createBrowserLiveHub(deps: {
  db: DbClient;
  registry: AgentRegistry;
}): BrowserLiveHub {
  function guardOrigin(
    req: Request,
    peerIp: string | undefined,
    endpoint: string,
  ): Response | null {
    const result = checkRequestOrigin(req, { peerIp });
    if (result.ok) return null;
    liveLog.warn(
      `rejecting ${endpoint} upgrade: reason=${result.reason} origin=${result.origin ?? "<missing>"}`,
    );
    if (result.hint) liveLog.info(`hint: ${result.hint}`);
    return new Response("Forbidden", { status: 403 });
  }

  const publicClients = new Set<ServerWebSocket<BrowserLiveWsData>>();
  const privilegedClients = new Set<ServerWebSocket<BrowserLiveWsData>>();
  const adminClients = new Set<ServerWebSocket<BrowserLiveWsData>>();

  const publicScope: PublicScopeConfig = {
    clients: publicClients,
    onlyPublic: true,
    knownIdsMap: new WeakMap(),
  };
  const privilegedScope: PublicScopeConfig = {
    clients: privilegedClients,
    onlyPublic: false,
    knownIdsMap: new WeakMap(),
  };

  function publishAdminPresenceDeltas(
    updates: Array<{
      agentId: string;
      online: boolean;
      lastSeenAtMs: number | null;
      lastIpV4?: string | null;
      lastIpV6?: string | null;
    }>,
  ) {
    if (adminClients.size === 0 || updates.length === 0) return;
    const payloads: string[] = [];
    for (const update of updates) {
      payloads.push(
        JSON.stringify({
          type: "event.admin.agent_delta",
          agentId: update.agentId,
          status: {
            online: update.online,
            lastSeenAtMs: update.lastSeenAtMs,
            lastIpV4: update.lastIpV4,
            lastIpV6: update.lastIpV6,
          },
        } satisfies AdminLiveMessage),
      );
    }
    for (const ws of adminClients) {
      for (const raw of payloads) sendRaw(ws, raw);
    }
  }

  function publishAdminTelemetryDeltas(
    batch: Array<{ args: TelemetryIngestArgs; result: TelemetryIngestResult }>,
  ) {
    if (adminClients.size === 0 || batch.length === 0) return;

    const latestByAgentId = deduplicateByLatest(batch);
    const payloads: string[] = [];
    for (const entry of latestByAgentId.values()) {
      payloads.push(
        JSON.stringify({
          type: "event.admin.agent_delta",
          agentId: entry.args.agentId,
          status: {
            online: true,
            lastSeenAtMs: entry.args.recvTsMs,
          },
          latest: {
            seq: entry.args.seq,
            rx: entry.args.rxBytesTotal,
            tx: entry.args.txBytesTotal,
            m: entry.result.numericMetrics,
          },
        } satisfies AdminLiveMessage),
      );
    }
    for (const ws of adminClients) {
      for (const raw of payloads) sendRaw(ws, raw);
    }
  }

  function publishAdminProbeLatest(batch: ProbeResultIngestArgs[]) {
    if (adminClients.size === 0 || batch.length === 0) return;

    const latestByPair = new Map<string, ProbeResultIngestArgs>();
    for (const entry of batch) {
      const key = `${entry.agentId}\u0000${entry.result.tid}`;
      const existing = latestByPair.get(key);
      if (
        !existing ||
        entry.result.ts > existing.result.ts ||
        (entry.result.ts === existing.result.ts && entry.recvTsMs >= existing.recvTsMs)
      ) {
        latestByPair.set(key, entry);
      }
    }

    const payloads: string[] = [];
    for (const entry of latestByPair.values()) {
      payloads.push(
        JSON.stringify({
          type: "event.admin.probe_latest",
          agentId: entry.agentId,
          taskId: entry.result.tid,
          latest: {
            tsMs: entry.result.ts,
            recvTsMs: entry.recvTsMs,
            ok: entry.result.ok,
            latMs: entry.result.lat_ms ?? null,
            code: entry.result.code ?? null,
            err: entry.result.err ?? null,
            extra: entry.result.x ?? null,
            lossPct: entry.result.loss ?? null,
            jitterMs: entry.result.jit_ms ?? null,
            updatedAtMs: entry.recvTsMs,
          },
        } satisfies AdminLiveMessage),
      );
    }

    for (const ws of adminClients) {
      for (const raw of payloads) sendRaw(ws, raw);
    }
  }

  function broadcastAgentChanges(agentIds: string[]) {
    const uniqueIds = uniqueStrings(agentIds);
    if (uniqueIds.length === 0) return;
    const nowMs = Date.now();
    broadcastAgentChangesToScope(deps.registry, publicScope, uniqueIds, nowMs);
    broadcastAgentChangesToScope(deps.registry, privilegedScope, uniqueIds, nowMs);
  }

  function broadcastTelemetryDeltasToScope(
    latestByAgentId: Map<string, { args: TelemetryIngestArgs; result: TelemetryIngestResult }>,
    scope: PublicScopeConfig,
  ) {
    if (scope.clients.size === 0 || latestByAgentId.size === 0) return;
    const rawByAgentId = new Map<string, string>();
    for (const entry of latestByAgentId.values()) {
      rawByAgentId.set(
        entry.args.agentId,
        JSON.stringify({
          type: "event.public.telemetry_delta",
          agentId: entry.args.agentId,
          tsMs: entry.args.recvTsMs,
          metrics: entry.result.numericMetrics,
          deltaRx: entry.result.deltaRx,
          deltaTx: entry.result.deltaTx,
        } satisfies PublicLiveMessage),
      );
    }
    for (const ws of scope.clients) {
      const knownIds = scope.knownIdsMap.get(ws);
      if (!knownIds) continue;
      for (const [agentId, raw] of rawByAgentId) {
        if (!knownIds.has(agentId)) continue;
        sendRaw(ws, raw);
      }
    }
  }

  async function resolveAdminUser(req: Request): Promise<{ id: string; tokenHash: string } | null> {
    const token = getCookieValue(req.headers.get("cookie"), SESSION_COOKIE_NAME);
    if (!token) return null;
    const tokenHash = hashSessionToken(token);
    const session = await findValidSession(deps.db, {
      tokenHash,
      nowMs: Date.now(),
    });
    if (!session || session.user.role !== "admin") return null;
    return { id: session.user.id, tokenHash };
  }

  const handlePublicUpgrade: BrowserLiveHub["handlePublicUpgrade"] = async (req, server) => {
    const blocked = guardOrigin(req, server.requestIP(req)?.address, "/live/public");
    if (blocked) return blocked;
    const user = await resolveAdminUser(req);
    const data: BrowserLiveWsData = user
      ? { kind: "live", scope: "privileged", userId: user.id, sessionTokenHash: user.tokenHash }
      : { kind: "live", scope: "public" };
    const ok = server.upgrade(req, { data });
    if (!ok) return new Response("Upgrade required", { status: 426 });
    return undefined;
  };

  const handleAdminUpgrade: BrowserLiveHub["handleAdminUpgrade"] = async (req, server) => {
    const blocked = guardOrigin(req, server.requestIP(req)?.address, "/live/admin");
    if (blocked) return blocked;
    const user = await resolveAdminUser(req);
    if (!user) return new Response("Unauthorized", { status: 401 });
    const ok = server.upgrade(req, {
      data: {
        kind: "live",
        scope: "admin",
        userId: user.id,
        sessionTokenHash: user.tokenHash,
      } satisfies BrowserLiveWsData,
    });
    if (!ok) return new Response("Upgrade required", { status: 426 });
    return undefined;
  };

  const websocket: BrowserLiveHub["websocket"] = {
    open(ws) {
      if (ws.data.scope === "public") {
        publicClients.add(ws);
        sendJson(ws, { type: "hello.public", tsMs: Date.now() } satisfies PublicLiveMessage);
        void sendScopeSnapshot(deps.registry, ws, publicScope);
        return;
      }

      if (ws.data.scope === "privileged") {
        privilegedClients.add(ws);
        sendJson(ws, { type: "hello.public", tsMs: Date.now() } satisfies PublicLiveMessage);
        void sendScopeSnapshot(deps.registry, ws, privilegedScope);
        return;
      }

      adminClients.add(ws);
      sendJson(ws, { type: "hello.admin", tsMs: Date.now() } satisfies AdminLiveMessage);
    },

    message(_ws, _message) {},

    close(ws) {
      if (ws.data.scope === "public") {
        publicClients.delete(ws);
        return;
      }
      if (ws.data.scope === "privileged") {
        privilegedClients.delete(ws);
        return;
      }
      adminClients.delete(ws);
    },
  };

  function collectActiveSessionTokenHashes(): string[] {
    const seen = new Set<string>();
    const collect = (set: Set<ServerWebSocket<BrowserLiveWsData>>) => {
      for (const ws of set) {
        const hash = ws.data.sessionTokenHash;
        if (hash !== undefined) seen.add(hash);
      }
    };
    collect(privilegedClients);
    collect(adminClients);
    return Array.from(seen);
  }

  function closeBySessionTokenHash(tokenHash: string) {
    for (const ws of privilegedClients) {
      if (ws.data.sessionTokenHash === tokenHash) ws.close(4001, "session_revoked");
    }
    for (const ws of adminClients) {
      if (ws.data.sessionTokenHash === tokenHash) ws.close(4001, "session_revoked");
    }
  }

  async function revalidateActiveSessions(check: SessionValidityChecker): Promise<number> {
    const hashes = collectActiveSessionTokenHashes();
    if (hashes.length === 0) return 0;
    const valid = await check(hashes);
    let revoked = 0;
    for (const hash of hashes) {
      if (valid.has(hash)) continue;
      closeBySessionTokenHash(hash);
      revoked += 1;
    }
    return revoked;
  }

  return {
    handlePublicUpgrade,
    handleAdminUpgrade,
    websocket,
    publishAgentChanges(agentIds) {
      broadcastAgentChanges(agentIds);
    },
    publishAdminGeo(agentId, geo) {
      if (adminClients.size === 0) return;
      const raw = JSON.stringify({
        type: "event.admin.agent_geo",
        agentId,
        geo,
      } satisfies AdminLiveMessage);
      for (const ws of adminClients) {
        sendRaw(ws, raw);
      }
    },
    publishTelemetryBatch(batch) {
      if (batch.length === 0) return;
      const agentIds = uniqueStrings(batch.map((entry) => entry.args.agentId));
      broadcastAgentChanges(agentIds);

      const latestByAgentId = deduplicateByLatest(batch);
      broadcastTelemetryDeltasToScope(latestByAgentId, publicScope);
      broadcastTelemetryDeltasToScope(latestByAgentId, privilegedScope);
      publishAdminTelemetryDeltas(batch);
    },
    publishAgentPresence(updates) {
      const agentIds = uniqueStrings(updates.map((entry) => entry.agentId));
      broadcastAgentChanges(agentIds);
      publishAdminPresenceDeltas(updates);
    },
    publishProbeLatestBatch(batch) {
      publishAdminProbeLatest(batch);
    },

    revalidateActiveSessions(check) {
      return revalidateActiveSessions(check);
    },

    disconnectBySession(tokenHash) {
      closeBySessionTokenHash(tokenHash);
    },

    disconnectByUser(userId) {
      for (const ws of privilegedClients) {
        if (ws.data.userId === userId) ws.close(4001, "session_revoked");
      }
      for (const ws of adminClients) {
        if (ws.data.userId === userId) ws.close(4001, "session_revoked");
      }
    },
  };
}
