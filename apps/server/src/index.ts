import type { Server, ServerWebSocket } from "bun";
import { AgentRegistry } from "./agents/registry";
import { startAlertEngine, setAlertTimezoneProvider } from "./alert";
import { createApp } from "./app";
import { ensureAdminUser } from "./auth/bootstrap";
import { startSessionCleanupWorker } from "./auth/cleanup";
import { startLoginAttemptCleanupWorker } from "./auth/login-attempts";
import { getDummyPasswordHash } from "./auth/password";
import { startSessionRevalidationWorker } from "./auth/revalidation";
import { startPricingRenewalWorker } from "./billing/renewal";
import { GEO_DATA_DIR, MAX_WS_PAYLOAD_BYTES, getServerConfig } from "./config";
import { closeDbClient, createDbClient } from "./db/client";
import { DbMaintenance } from "./db/maintenance";
import { createAsnLookupService } from "./geo/asn";
import { createGeoLookup } from "./geo/lookup";
import { resetAllAgentsOffline } from "./ingest/status";
import { createBrowserLiveHub, type BrowserLiveWsData } from "./live/hub";
import { installConsoleCapture } from "./logging/buffer";
import { getMigrationsFolder, resolvePathFromCwd } from "./paths";
import { WsUpgradeRateLimiter } from "./rate-limit/ws-upgrade";
import { startProbeRollupWorker } from "./rollup/probe";
import { startTelemetryRollupWorker } from "./rollup/telemetry";
import { RuntimeAgentConfigStore, loadRuntimeAgentConfig } from "./settings/runtime";
import { SiteConfigStore, loadSiteConfig } from "./settings/site-config";
import { configureTrustedProxies, resolveClientIp } from "./util/trust-proxy";
import { VERSION } from "./version";
import { startVersionCheck, stopVersionCheck } from "./version-check";
import { createWsHub } from "./ws/hub";
import type { AgentWsData } from "./ws/hub";

const config = getServerConfig();
configureTrustedProxies(config.trustedProxyExtras);

installConsoleCapture();

const dbPath = resolvePathFromCwd(config.dbPath);
const db = await createDbClient({
  dbPath,
  migrationsFolder: getMigrationsFolder(),
});
const bootstrap = await ensureAdminUser(db, { dbPath });
if (bootstrap.created) {
  if (bootstrap.credentialFile) {
    console.log(`Admin user created. Credentials written to: ${bootstrap.credentialFile}`);
  } else {
    console.log("Admin user created with password from HINA_ADMIN_PASSWORD.");
  }
}

const dummyHashReady = getDummyPasswordHash();

const runtimeAgentLoaded = await loadRuntimeAgentConfig(db);
const runtimeAgentConfig = new RuntimeAgentConfigStore({
  current: runtimeAgentLoaded.current,
  source: runtimeAgentLoaded.source,
});

const siteConfigLoaded = await loadSiteConfig(db);
const siteConfig = new SiteConfigStore({ current: siteConfigLoaded });
setAlertTimezoneProvider(() => siteConfig.getCurrent().timezone);

await resetAllAgentsOffline(db);

const agentRegistry = new AgentRegistry(db);
await agentRegistry.load();

const liveHub = createBrowserLiveHub({
  db,
  registry: agentRegistry,
});
const geoLookup = createGeoLookup();

const asnLookupService = createAsnLookupService(resolvePathFromCwd(GEO_DATA_DIR));

const agentUpgradeLimiter = new WsUpgradeRateLimiter({ limit: 30 });
const liveUpgradeLimiter = new WsUpgradeRateLimiter({ limit: 20 });

const dbMaintenance = new DbMaintenance(dbPath);

const wsHub = createWsHub({
  db,
  liveHub,
  registry: agentRegistry,
  runtimeAgentConfig,
  geoLookup,
  asnLookup: asnLookupService,
});
const app = createApp({
  db,
  dbMaintenance,
  registry: agentRegistry,
  liveHub,
  runtimeAgentConfig,
  siteConfig,
  probeDispatcher: wsHub.probeDispatcher,
  asnLookupService,
});

const stopWorkers: Array<() => Promise<void>> = [
  startProbeRollupWorker({ db }),
  startTelemetryRollupWorker({ db }),
  startAlertEngine({ db, runtimeAgentConfig, siteConfig, registry: agentRegistry }),
  startSessionCleanupWorker({ db }),
  startSessionRevalidationWorker({ db, liveHub }),
  startLoginAttemptCleanupWorker({ db }),
  startPricingRenewalWorker({ db, registry: agentRegistry, liveHub }),
];
if (siteConfigLoaded.versionCheckEnabled) {
  startVersionCheck();
  stopWorkers.push(async () => stopVersionCheck());
}

await dummyHashReady;

type SocketData = AgentWsData | BrowserLiveWsData;

function toAgentServer(server: Server<SocketData>): Server<AgentWsData> {
  return server as Server<AgentWsData>;
}

function toLiveServer(server: Server<SocketData>): Server<BrowserLiveWsData> {
  return server as Server<BrowserLiveWsData>;
}

function toAgentSocket(ws: ServerWebSocket<SocketData>): ServerWebSocket<AgentWsData> {
  return ws as ServerWebSocket<AgentWsData>;
}

function toLiveSocket(ws: ServerWebSocket<SocketData>): ServerWebSocket<BrowserLiveWsData> {
  return ws as ServerWebSocket<BrowserLiveWsData>;
}

const server = Bun.serve<SocketData>({
  port: config.port,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (
      url.pathname === "/ws" ||
      url.pathname === "/live/public" ||
      url.pathname === "/live/admin"
    ) {
      const ip = resolveClientIp(req, server.requestIP(req)?.address) ?? "unknown";
      const limiter = url.pathname === "/ws" ? agentUpgradeLimiter : liveUpgradeLimiter;
      if (!limiter.check(ip)) {
        return new Response("Too Many Requests", { status: 429 });
      }
    }

    try {
      if (url.pathname === "/ws") return wsHub.handleUpgrade(req, toAgentServer(server));
      if (url.pathname === "/live/public")
        return await liveHub.handlePublicUpgrade(req, toLiveServer(server));
      if (url.pathname === "/live/admin")
        return await liveHub.handleAdminUpgrade(req, toLiveServer(server));
    } catch (err) {
      console.error(`WebSocket upgrade failed: ${url.pathname}`, err);
      return new Response("Internal Server Error", { status: 500 });
    }
    return app.fetch(req, { connectionIp: server.requestIP(req)?.address });
  },
  websocket: {
    maxPayloadLength: MAX_WS_PAYLOAD_BYTES,
    open(ws) {
      if (ws.data.kind === "live") {
        liveHub.websocket.open(toLiveSocket(ws));
        return;
      }
      wsHub.websocket.open(toAgentSocket(ws));
    },
    message(ws, message) {
      if (ws.data.kind === "live") {
        liveHub.websocket.message(toLiveSocket(ws), message);
        return;
      }
      wsHub.websocket.message(toAgentSocket(ws), message);
    },
    close(ws) {
      if (ws.data.kind === "live") {
        liveHub.websocket.close(toLiveSocket(ws));
        return;
      }
      wsHub.websocket.close(toAgentSocket(ws));
    },
  },
});

console.log(`hina-server v${VERSION} listening on :${config.port}`);

const SHUTDOWN_TIMEOUT_MS = 10_000;

function withTimeout(promise: Promise<unknown>, ms: number, label: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`${label} timed out after ${ms}ms, forcing exit`);
      resolve();
    }, ms);
    promise
      .catch((err) => console.error(`${label} failed`, err))
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

let shuttingDown = false;
async function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`shutting down (${signal})...`);
  agentUpgradeLimiter.stop();
  liveUpgradeLimiter.stop();
  await withTimeout(server.stop(true), SHUTDOWN_TIMEOUT_MS, "server.stop");
  await withTimeout(wsHub.stop(), SHUTDOWN_TIMEOUT_MS, "wsHub.stop");
  await withTimeout(
    Promise.all(stopWorkers.map((stop) => stop())),
    SHUTDOWN_TIMEOUT_MS,
    "workers.stop",
  );
  await withTimeout(dbMaintenance.close(), SHUTDOWN_TIMEOUT_MS, "dbMaintenance.close");
  closeDbClient(db);
  process.exit(exitCode);
}
let rejectionCount = 0;
let rejectionWindowStart = Date.now();
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection", reason);
  const now = Date.now();
  if (now - rejectionWindowStart > 60_000) {
    rejectionCount = 0;
    rejectionWindowStart = now;
  }
  rejectionCount++;
  if (rejectionCount >= 5) {
    void shutdown("unhandledRejection_repeated", 1);
  }
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err);
  void shutdown("uncaughtException", 1);
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
