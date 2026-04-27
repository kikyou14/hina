import { Hono } from "hono";
import type { AgentRegistry } from "../agents/registry";
import type { AppContext } from "../app";
import type { SessionTouchThrottler } from "../auth/session";
import { queryTelemetrySeries } from "../queries/telemetry-series";
import { publicGlobal, publicHeavy, publicStd } from "../rate-limit/limiters";
import { VERSION } from "../version";
import { getLatestRelease } from "../version-check";
import {
  parseMaxPoints,
  parseMaxProbePoints,
  parseMs,
  parseProbeSeriesTier,
  parseResolution,
} from "./helpers";
import {
  formatProbeLatestResults,
  queryProbeLatest,
  queryProbeResultSeries,
  resolveVisibleTask,
} from "./probe-queries";
import { createResolveOptionalSession } from "./public-middleware";

async function isAgentVisibleInRegistry(
  registry: AgentRegistry,
  agentId: string,
  isAdmin: boolean,
): Promise<boolean> {
  if (!(await registry.ensureAgent(agentId))) return false;
  const summary = registry.getSummary(agentId);
  if (!summary) return false;
  return isAdmin ? true : summary.isPublic;
}

export function createPublicRouter(touchThrottler: SessionTouchThrottler) {
  const router = new Hono<AppContext>();

  router.use("*", publicGlobal);
  router.use("*", createResolveOptionalSession(touchThrottler));

  router.get("/site-config", (c) => {
    const store = c.get("siteConfig");
    const config = store.getCurrent();
    const release = getLatestRelease();
    return c.json({
      siteName: config.siteName,
      siteDescription: config.siteDescription,
      customFooterHtml: config.customFooterHtml,
      timezone: config.timezone,
      hasFavicon: !!config.favicon,
      faviconVersion: store.faviconVersion,
      sortOfflineLast: config.sortOfflineLast,
      hideTracerouteForGuests: config.hideTracerouteForGuests,
      serverVersion: VERSION,
      latestVersion: release?.version ?? null,
      releaseUrl: release?.url ?? null,
    });
  });

  router.get("/favicon", (c) => {
    const { favicon } = c.get("siteConfig").getCurrent();
    if (!favicon) {
      return c.redirect("/icon/favicon.ico");
    }
    const match = favicon.match(/^data:(image\/[^;,]+);base64,(.+)$/);
    if (!match) {
      return c.redirect("/icon/favicon.ico");
    }
    const binary = Buffer.from(match[2], "base64");
    c.header("Content-Type", match[1]);
    c.header("Cache-Control", "public, no-cache");
    c.header("Content-Security-Policy", "default-src 'none'");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(binary);
  });

  router.get("/agents", publicStd, async (c) => {
    const registry = c.get("registry");
    const isAdmin = !!c.get("authUser");
    await registry.syncFromDbIfStale();
    const agents = isAdmin ? registry.listSummaries() : registry.listPublicSummaries();
    return c.json({ agents });
  });

  router.get("/agents/:agentId", publicStd, async (c) => {
    const registry = c.get("registry");
    const agentId = c.req.param("agentId");
    const isAdmin = !!c.get("authUser");

    await registry.ensureAgent(agentId);
    const detail = isAdmin ? registry.getDetail(agentId) : registry.getPublicDetail(agentId);
    if (!detail) return c.json({ code: "not_found" }, 404);
    return c.json(detail);
  });

  router.get("/agents/:agentId/series", publicHeavy, async (c) => {
    const db = c.get("db");
    const registry = c.get("registry");
    const agentId = c.req.param("agentId");
    const isAdmin = !!c.get("authUser");

    const nowMs = Date.now();
    const fromMs = parseMs(c.req.query("from")) ?? nowMs - 24 * 60 * 60 * 1000;
    const toMs = parseMs(c.req.query("to")) ?? nowMs;
    const resolution = parseResolution(c.req.query("resolution"));
    const maxPoints = parseMaxPoints(c.req.query("maxPoints"), 2000);

    if (!(toMs > fromMs)) return c.json({ code: "invalid_range" }, 400);
    if (toMs - fromMs > 31 * 24 * 60 * 60 * 1000) return c.json({ code: "range_too_large" }, 400);

    if (!(await isAgentVisibleInRegistry(registry, agentId, isAdmin)))
      return c.json({ code: "not_found" }, 404);

    const result = await queryTelemetrySeries(db, {
      agentId,
      fromMs,
      toMs,
      resolution,
      maxPoints,
    });
    if (!result.ok) return c.json(result.error, 400);
    return c.json(result.body);
  });

  router.get("/agents/:agentId/probe-latest", publicStd, async (c) => {
    const db = c.get("db");
    const registry = c.get("registry");
    const agentId = c.req.param("agentId");
    const isAdmin = !!c.get("authUser");

    if (!(await isAgentVisibleInRegistry(registry, agentId, isAdmin)))
      return c.json({ code: "not_found" }, 404);

    const rows = await queryProbeLatest(db, agentId);
    let results = formatProbeLatestResults(rows, isAdmin ? "full" : "anonymized");
    if (!isAdmin && c.get("siteConfig").getCurrent().hideTracerouteForGuests) {
      results = results.filter((r) => r.task.kind !== "traceroute");
    }
    return c.json({ agentId, results });
  });

  router.get("/probe-results/series", publicHeavy, async (c) => {
    const db = c.get("db");
    const registry = c.get("registry");
    const isAdmin = !!c.get("authUser");

    const agentId = (c.req.query("agentId") ?? "").trim();
    const taskId = (c.req.query("taskId") ?? "").trim();
    if (!agentId || !taskId) return c.json({ ok: false, code: "missing_agent_or_task" }, 400);

    const nowMs = Date.now();
    const fromMs = parseMs(c.req.query("from")) ?? nowMs - 24 * 60 * 60 * 1000;
    const toMs = parseMs(c.req.query("to")) ?? nowMs;
    const maxPoints = parseMaxProbePoints(c.req.query("maxPoints"), 50_000);
    const requestedTier = parseProbeSeriesTier(c.req.query("tier"));

    if (!(toMs > fromMs)) return c.json({ ok: false, code: "invalid_range" }, 400);
    if (toMs - fromMs > 35 * 24 * 60 * 60 * 1000)
      return c.json({ ok: false, code: "range_too_large" }, 400);

    if (!(await isAgentVisibleInRegistry(registry, agentId, isAdmin)))
      return c.json({ ok: false, code: "not_found" }, 404);

    if (!isAdmin) {
      const task = await resolveVisibleTask(db, taskId, agentId);
      if (!task) return c.json({ ok: false, code: "not_found" }, 404);
      if (task.kind === "traceroute" && c.get("siteConfig").getCurrent().hideTracerouteForGuests)
        return c.json({ ok: false, code: "not_found" }, 404);
    }

    const result = await queryProbeResultSeries(db, {
      agentId,
      taskId,
      fromMs,
      toMs,
      maxPoints,
      requestedTier,
    });
    if (result.status === 400) return c.json(result.body, 400);
    return c.json(result.body);
  });

  return router;
}
