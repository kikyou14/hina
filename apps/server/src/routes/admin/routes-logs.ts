import type { Hono } from "hono";
import type { AppContext } from "../../app";
import { logBuffer, type LogRingBuffer } from "../../logging/buffer";
import { parseNonNegativeIntQuery } from "./parsing";

export function registerAdminLogRoutes(
  router: Hono<AppContext>,
  buffer: LogRingBuffer = logBuffer,
) {
  router.get("/logs", (c) => {
    const limit = Math.min(parseNonNegativeIntQuery(c.req.query("limit")) ?? 200, 2000);
    const after = c.req.query("after");
    const sinceTsMs = parseNonNegativeIntQuery(c.req.query("sinceTsMs"));
    const page = buffer.list({
      after: after || undefined,
      sinceTsMs: sinceTsMs ?? undefined,
      limit,
    });
    return c.json({ nowMs: Date.now(), ...page });
  });
}
