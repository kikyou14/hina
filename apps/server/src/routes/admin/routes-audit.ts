import type { Hono } from "hono";
import type { AppContext } from "../../app";
import { listLoginAttempts } from "../../auth/login-attempts";
import { parseNonNegativeIntQuery, parsePositiveIntQuery } from "./parsing";

export function registerAdminAuditRoutes(router: Hono<AppContext>) {
  router.get("/audit/logins", async (c) => {
    const db = c.get("db");

    const limit = Math.min(parsePositiveIntQuery(c.req.query("limit")) ?? 50, 200);
    const offset = parseNonNegativeIntQuery(c.req.query("offset")) ?? 0;
    const onlyFailures = c.req.query("onlyFailures") === "1";

    const { rows, hasMore } = await listLoginAttempts(db, { limit, offset, onlyFailures });

    return c.json({ ok: true, nowMs: Date.now(), logs: rows, hasMore });
  });
}
