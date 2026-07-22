import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { AgentPublicSummary, AgentRegistry } from "../agents/registry";
import type { DbClient } from "../db/client";
import type { TelemetryIngestArgs, TelemetryIngestResult } from "../ingest/telemetry";
import { type BrowserLiveWsData, createBrowserLiveHub } from "./hub";

// Minimal live socket. `send` returns -1 in "buffer" mode to model Bun
// backpressure (frame buffered, delivered later, drain will fire) and records
// delivered frames in "ok" mode.
function makeWs(scope: BrowserLiveWsData["scope"], protocol?: number) {
  const sent: string[] = [];
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  let mode: "ok" | "buffer" = "ok";
  const data: BrowserLiveWsData = { kind: "live", scope, protocol };
  const ws = {
    data,
    send(payload: string) {
      if (mode === "ok") {
        sent.push(payload);
        return payload.length;
      }
      return -1;
    },
    cork(fn: () => void) {
      return fn();
    },
    close(code?: number, reason?: string) {
      closeCalls.push({ code, reason });
    },
  };
  return {
    ws: ws as unknown as ServerWebSocket<BrowserLiveWsData>,
    sent,
    closeCalls,
    setMode: (m: "ok" | "buffer") => {
      mode = m;
    },
  };
}

function makeHub(agentVersion: string | null = null, summaries: AgentPublicSummary[] = []) {
  return createBrowserLiveHub({
    db: {} as unknown as DbClient,
    registry: {
      syncFromDb: async () => {},
      listPublicSummaries: () => summaries.filter((summary) => summary.isPublic),
      listSummaries: () => summaries,
      getSummary: (agentId: string) => summaries.find((summary) => summary.id === agentId) ?? null,
      getAgentVersion: () => agentVersion,
    } as unknown as AgentRegistry,
  });
}

function makePublicSummary(): AgentPublicSummary {
  return {
    id: "a1",
    name: "Alpha",
    isPublic: true,
    group: null,
    tags: [],
    geo: { countryCode: null, country: null },
    status: { online: true, lastSeenAtMs: 200 },
    system: { os: null, arch: null, helloAtMs: null },
    latest: null,
    billing: {
      quotaBytes: 1_000,
      mode: "sum",
      resetDay: 1,
      periodStartDayYyyyMmDd: 20260701,
      periodEndDayYyyyMmDd: 20260722,
      rxBytes: 400,
      txBytes: 300,
      usedBytes: 700,
      overQuota: false,
    },
    traffic: {
      totalRxBytes: 5_000,
      totalTxBytes: 6_000,
      sinceDayYyyyMmDd: 20260701,
    },
    pricing: null,
  };
}

function makeTelemetryEntry(
  args: Partial<TelemetryIngestArgs> = {},
  result: Partial<TelemetryIngestResult> = {},
): { args: TelemetryIngestArgs; result: TelemetryIngestResult } {
  return {
    args: {
      agentId: "a1",
      recvTsMs: 200,
      seq: 5,
      uptimeSec: 10,
      rxBytesTotal: 500,
      txBytesTotal: 600,
      latestTelemetryPack: Buffer.alloc(0),
      numericMetrics: {},
      ...args,
    },
    result: {
      numericMetrics: { "cpu.usage_pct": 42 },
      deltaRx: 10,
      deltaTx: 20,
      trafficDayYyyyMmDd: 20260722,
      ...result,
    },
  };
}

describe("BrowserLiveHub admin backpressure", () => {
  test("presence and telemetry survive backpressure on independent channels, in order", () => {
    const hub = makeHub();
    const { ws, sent, setMode } = makeWs("admin");

    // Open while backpressured: the hello frame trips backpressure and every
    // later frame is held in the outbox rather than written straight through.
    setMode("buffer");
    hub.websocket.open(ws);

    // Presence first (brings IP + agentVersion), then a newer telemetry delta
    // (brings `latest`). Neither message is a full agent state.
    hub.publishAgentPresence([
      {
        agentId: "a1",
        online: true,
        lastSeenAtMs: 100,
        lastIpV4: "203.0.113.7",
        lastIpV6: null,
        system: { agentVersion: "9.9.9" },
      },
    ]);
    hub.publishTelemetryBatch([
      {
        args: {
          agentId: "a1",
          recvTsMs: 200,
          seq: 5,
          uptimeSec: 1,
          rxBytesTotal: 10,
          txBytesTotal: 20,
          latestTelemetryPack: Buffer.alloc(0),
          numericMetrics: {},
        },
        result: {
          numericMetrics: { "cpu.usage_pct": 42 },
          deltaRx: 1,
          deltaTx: 2,
          trafficDayYyyyMmDd: null,
        },
      },
    ]);

    // Both are coalesced (distinct keys) and nothing has been delivered yet.
    expect(sent).toEqual([]);

    setMode("ok");
    hub.websocket.drain(ws);

    const deltas = sent
      .map((raw) => JSON.parse(raw))
      .filter((m) => m.type === "event.admin.agent_delta");
    const presence = deltas.find((m) => m.status?.lastIpV4 === "203.0.113.7");
    const telemetry = deltas.find((m) => m.latest);

    // Sharing one `ad:${id}` key would have let the telemetry frame overwrite the
    // unsent presence frame, permanently dropping the IP + agentVersion update.
    expect(presence).toBeDefined();
    expect(presence.system.agentVersion).toBe("9.9.9");
    expect(telemetry).toBeDefined();
    expect(telemetry.latest.seq).toBe(5);
    expect(telemetry.latest.m["cpu.usage_pct"]).toBe(42);

    // Last-write order preserved: presence (enqueued first) replays before the
    // newer telemetry frame, so the client applies the freshest state last.
    const presenceIdx = sent.findIndex((r) => r.includes("203.0.113.7"));
    const telemetryIdx = sent.findIndex((r) => r.includes('"latest"'));
    expect(presenceIdx).toBeGreaterThanOrEqual(0);
    expect(presenceIdx).toBeLessThan(telemetryIdx);
  });

  test("presence stays a complete state across HELLO then offline (agentVersion filled from registry)", () => {
    const hub = makeHub("9.9.9");
    const { ws, sent, setMode } = makeWs("admin");

    setMode("buffer");
    hub.websocket.open(ws);

    // HELLO frame carries agentVersion; the later offline frame does NOT.
    hub.publishAgentPresence([
      {
        agentId: "a1",
        online: true,
        lastSeenAtMs: 100,
        lastIpV4: "203.0.113.7",
        lastIpV6: null,
        system: { agentVersion: "9.9.9" },
      },
    ]);
    hub.publishAgentPresence([
      { agentId: "a1", online: false, lastSeenAtMs: 200, lastIpV4: "203.0.113.7", lastIpV6: null },
    ]);

    setMode("ok");
    hub.websocket.drain(ws);

    // Both presence frames coalesce onto ad:presence:a1, so only the latest
    // (offline) survives — and it still carries agentVersion, filled from the
    // registry, so a system-less offline frame no longer erases the version.
    const deltas = sent
      .map((raw) => JSON.parse(raw))
      .filter((m) => m.type === "event.admin.agent_delta");
    const last = deltas[deltas.length - 1];
    expect(last.status.online).toBe(false);
    expect(last.system.agentVersion).toBe("9.9.9");
  });

  test("capabilitiesChanged flags HELLO only, not IP change or disconnect", () => {
    const hub = makeHub("9.9.9");
    const { ws, sent } = makeWs("admin");
    hub.websocket.open(ws);

    // HELLO carries system: the agent (re)connected -> re-scan probe tasks.
    hub.publishAgentPresence([
      {
        agentId: "a1",
        online: true,
        lastSeenAtMs: 100,
        lastIpV4: "203.0.113.7",
        lastIpV6: null,
        system: { agentVersion: "9.9.9" },
      },
    ]);
    // IP change: presence-only, no capability re-scan.
    hub.publishAgentPresence([
      { agentId: "a1", online: true, lastSeenAtMs: 200, lastIpV4: "203.0.113.8", lastIpV6: null },
    ]);
    // Disconnect: presence-only, no capability re-scan.
    hub.publishAgentPresence([
      { agentId: "a1", online: false, lastSeenAtMs: 300, lastIpV4: "203.0.113.8", lastIpV6: null },
    ]);

    const deltas = sent
      .map((raw) => JSON.parse(raw))
      .filter((m) => m.type === "event.admin.agent_delta");
    const hello = deltas.find((m) => m.status.lastIpV4 === "203.0.113.7");
    const ipChange = deltas.find(
      (m) => m.status.lastIpV4 === "203.0.113.8" && m.status.online === true,
    );
    const offline = deltas.find((m) => m.status.online === false);

    // Only HELLO carries the capability-changed signal.
    expect(hello.capabilitiesChanged).toBe(true);
    // Presence-only frames keep the mergeable version but never trigger a re-scan.
    expect(ipChange.capabilitiesChanged).toBeUndefined();
    expect(offline.capabilitiesChanged).toBeUndefined();
    expect(ipChange.system.agentVersion).toBe("9.9.9");
    expect(offline.system.agentVersion).toBe("9.9.9");
  });
});

describe("BrowserLiveHub public telemetry", () => {
  // Let the async initial snapshot (open -> syncFromDb -> snapshot) settle so
  // the client's server-side known-id set is populated; telemetry deltas are
  // only forwarded for already-known agents.
  const settleSnapshot = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("delta carries absolute billing and lifetime traffic state", async () => {
    const summary = makePublicSummary();
    const hub = makeHub(null, [summary]);
    const { ws, sent } = makeWs("public", 2);

    hub.websocket.open(ws);
    await settleSnapshot();

    hub.publishTelemetryBatch([makeTelemetryEntry()]);

    const delta = sent
      .map((raw) => JSON.parse(raw))
      .find((message) => message.type === "event.public.telemetry_delta");

    expect(delta).toBeDefined();
    expect(delta.billing).toEqual(summary.billing);
    expect(delta.traffic).toEqual(summary.traffic);
  });

  test("telemetry mirrors an agent_upsert to legacy (v1) clients but not modern (v2) ones", async () => {
    const summary = makePublicSummary();
    const hub = makeHub(null, [summary]);
    const legacy = makeWs("public"); // no advertised version -> treated as v1
    const modern = makeWs("public", 2);

    hub.websocket.open(legacy.ws);
    hub.websocket.open(modern.ws);
    await settleSnapshot();

    hub.publishTelemetryBatch([makeTelemetryEntry()]);

    const typesOf = (sent: string[]) => sent.map((raw) => JSON.parse(raw).type);
    const legacyTypes = typesOf(legacy.sent);
    const modernTypes = typesOf(modern.sent);

    // Both still receive the delta: legacy detail uses it for live charts, and
    // modern clients apply it as the full state patch.
    expect(legacyTypes).toContain("event.public.telemetry_delta");
    expect(modernTypes).toContain("event.public.telemetry_delta");

    // Only the legacy bundle, which refreshes its list/detail state solely from
    // agent_upsert, gets the transitional full upsert on every tick.
    expect(legacyTypes).toContain("event.public.agent_upsert");
    expect(modernTypes).not.toContain("event.public.agent_upsert");

    const upsert = legacy.sent
      .map((raw) => JSON.parse(raw))
      .find((message) => message.type === "event.public.agent_upsert");
    expect(upsert.agent.id).toBe("a1");
  });

  test("all-modern fleet does no upsert work on telemetry", async () => {
    const summary = makePublicSummary();
    const hub = makeHub(null, [summary]);
    const { ws, sent } = makeWs("public", 2);

    hub.websocket.open(ws);
    await settleSnapshot();

    hub.publishTelemetryBatch([makeTelemetryEntry()]);

    // With no legacy client connected, the transitional bridge short-circuits.
    const types = sent.map((raw) => JSON.parse(raw).type);
    expect(types).toContain("event.public.telemetry_delta");
    expect(types).not.toContain("event.public.agent_upsert");
  });
});

describe("BrowserLiveHub snapshot failure", () => {
  test("closes the socket when the initial snapshot fails so the client reconnects", async () => {
    const hub = createBrowserLiveHub({
      db: {} as unknown as DbClient,
      registry: {
        syncFromDb: async () => {
          throw new Error("db unavailable");
        },
        listPublicSummaries: () => [],
        listSummaries: () => [],
        getSummary: () => null,
        getAgentVersion: () => null,
      } as unknown as AgentRegistry,
    });
    const { ws, sent, closeCalls } = makeWs("public");

    hub.websocket.open(ws);
    // open() fires sendScopeSnapshot without awaiting; let the rejected syncFromDb
    // settle through its catch so the close lands.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A socket left after only the hello frame would silently drop every telemetry
    // delta (broadcasts skip scopes without a known-id set), so it must be closed
    // to force a reconnect + re-snapshot rather than left half-open.
    expect(closeCalls).toEqual([{ code: 1011, reason: "snapshot_failed" }]);
    const types = sent.map((raw) => JSON.parse(raw).type);
    expect(types).toContain("hello.public");
    expect(types).not.toContain("snapshot.public.agents");
  });
});
