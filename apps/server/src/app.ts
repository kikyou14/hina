import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { NONCE, secureHeaders } from "hono/secure-headers";
import type { SecureHeadersVariables } from "hono/secure-headers";
import type { AgentRegistry } from "./agents/registry";
import { type AuthUser, SessionTouchThrottler } from "./auth/session";
import { WEB_DIST_PATH } from "./config";
import type { DbClient } from "./db/client";
import type { DbMaintenance } from "./db/maintenance";
import type { AsnLookupService } from "./geo/asn";
import type { BrowserLiveHub } from "./live/hub";
import { createLogger } from "./logging/logger";
import { resolvePathFromServerRoot } from "./paths";
import { createAdminRouter } from "./routes/admin";
import { createPublicRouter } from "./routes/public";
import type { RuntimeAgentConfigStore } from "./settings/runtime";
import type { SiteConfigStore } from "./settings/site-config";
import { renderIndexHtml } from "./template/index-html";
import { isSecureRequest } from "./util/http";
import type { ProbeDispatcher } from "./ws/hub";

export type AppContext = {
  Bindings: {
    connectionIp?: string;
  };
  Variables: {
    db: DbClient;
    dbMaintenance: DbMaintenance;
    registry: AgentRegistry;
    liveHub?: BrowserLiveHub;
    runtimeAgentConfig: RuntimeAgentConfigStore;
    siteConfig: SiteConfigStore;
    authUser?: AuthUser;
    sessionTokenHash?: string;
    probeDispatcher?: ProbeDispatcher;
    asnLookupService?: AsnLookupService;
  } & SecureHeadersVariables;
};

export type AppDeps = {
  db: DbClient;
  dbMaintenance: DbMaintenance;
  registry: AgentRegistry;
  liveHub?: BrowserLiveHub;
  runtimeAgentConfig: RuntimeAgentConfigStore;
  siteConfig: SiteConfigStore;
  probeDispatcher?: ProbeDispatcher;
  asnLookupService?: AsnLookupService;
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppContext>();
  const httpLog = createLogger("http");

  app.onError((err, c) => {
    httpLog.error(`${c.req.method} ${c.req.path} unhandled error`, err);
    return c.json({ code: "internal_error" }, 500);
  });

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: [NONCE, "'strict-dynamic'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
      },
      strictTransportSecurity: false,
    }),
  );

  app.use(async (c, next) => {
    c.set("db", deps.db);
    c.set("dbMaintenance", deps.dbMaintenance);
    c.set("registry", deps.registry);
    c.set("liveHub", deps.liveHub);
    c.set("runtimeAgentConfig", deps.runtimeAgentConfig);
    c.set("siteConfig", deps.siteConfig);
    c.set("probeDispatcher", deps.probeDispatcher);
    c.set("asnLookupService", deps.asnLookupService);
    if (isSecureRequest(c.req.raw, c.env.connectionIp)) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    await next();
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  const touchThrottler = new SessionTouchThrottler();
  const dbPath = deps.db.$client.filename;
  app.route("/api/public", createPublicRouter(touchThrottler));
  app.route("/api/admin", createAdminRouter(touchThrottler, dbPath));

  const distRoot = resolvePathFromServerRoot(WEB_DIST_PATH);
  const indexPath = path.join(distRoot, "index.html");

  if (existsSync(indexPath)) {
    const indexTemplate = readFileSync(indexPath, "utf-8");

    const staticMiddleware = serveStatic({
      root: distRoot,
      precompressed: true,
      onFound(filePath, c) {
        if (filePath.endsWith(".html")) {
          c.header("Cache-Control", "no-store");
          return;
        }
        if (filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes("/assets/")) {
          c.header("Cache-Control", "public, max-age=31536000, immutable");
          return;
        }
        c.header("Cache-Control", "public, max-age=600");
      },
    });

    app.use("*", async (c, next) => {
      const p = c.req.path;
      if (p.startsWith("/api") || p === "/ws") return next();
      // Let the SPA entry fall through to the dynamic handler below so that
      // `/` and `/index.html` never return the raw static template (which
      // `serveStatic` would otherwise resolve via its directory index).
      if (p === "/" || p === "/index.html") return next();
      return staticMiddleware(c, next);
    });

    app.get("*", async (c, next) => {
      const p = c.req.path;
      if (p.startsWith("/api") || p === "/ws") return next();
      const html = renderIndexHtml({
        template: indexTemplate,
        siteConfig: c.get("siteConfig"),
        isAdminPath: p.startsWith("/admin"),
        nonce: c.get("secureHeadersNonce"),
      });
      c.header("Cache-Control", "no-store");
      return c.html(html);
    });
  }

  return app;
}
