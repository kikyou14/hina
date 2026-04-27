import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { deleteCookie } from "hono/cookie";
import type { AppContext } from "../../app";
import { hashPassword, verifyPassword } from "../../auth/password";
import {
  SESSION_COOKIE_NAME,
  type SessionTouchThrottler,
  revokeUserSessions,
} from "../../auth/session";
import { user as userTable } from "../../db/schema";
import { logBuffer } from "../../logging/buffer";
import { isSecureRequest } from "../../util/http";
import { parseNonNegativeIntQuery, parsePositiveIntQuery, isRecord } from "./parsing";

const accountMutationLimiter = rateLimiter<AppContext>({
  windowMs: 60_000,
  limit: 5,
  keyGenerator: (c) => {
    const authUser = c.get("authUser");
    return authUser ? `user:${authUser.id}` : "unknown";
  },
  standardHeaders: "draft-7",
  message: { code: "rate_limit_exceeded" },
});

export function registerAdminAccountRoutes(
  router: Hono<AppContext>,
  touchThrottler: SessionTouchThrottler,
) {
  router.patch("/account/username", accountMutationLimiter, async (c) => {
    const db = c.get("db");
    const authUser = c.get("authUser");
    if (!authUser) return c.json({ code: "unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const username = typeof body["username"] === "string" ? body["username"].trim() : "";
    const currentPassword =
      typeof body["currentPassword"] === "string" ? body["currentPassword"] : "";
    if (!username || username.length > 64) return c.json({ code: "invalid_username" }, 400);
    if (!currentPassword) return c.json({ code: "invalid_password" }, 400);

    const rows = await db
      .select({
        id: userTable.id,
        username: userTable.username,
        passwordHash: userTable.passwordHash,
      })
      .from(userTable)
      .where(eq(userTable.id, authUser.id))
      .limit(1);
    if (rows.length === 0) return c.json({ code: "unauthorized" }, 401);
    const u = rows[0]!;

    if (!(await verifyPassword(currentPassword, u.passwordHash)))
      return c.json({ code: "invalid_credentials" }, 401);
    if (username === u.username) return c.json({ ok: true, username });

    const existing = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.username, username))
      .limit(1);
    if (existing.length > 0 && existing[0]!.id !== u.id)
      return c.json({ code: "username_taken" }, 409);

    const nowMs = Date.now();
    try {
      await db
        .update(userTable)
        .set({ username, updatedAtMs: nowMs })
        .where(eq(userTable.id, u.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes("unique") && msg.toLowerCase().includes("user.username")) {
        return c.json({ code: "username_taken" }, 409);
      }
      throw err;
    }

    return c.json({ ok: true, username });
  });

  router.patch("/account/password", accountMutationLimiter, async (c) => {
    const db = c.get("db");
    const authUser = c.get("authUser");
    if (!authUser) return c.json({ code: "unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const currentPassword =
      typeof body["currentPassword"] === "string" ? body["currentPassword"] : "";
    const newPassword = typeof body["newPassword"] === "string" ? body["newPassword"] : "";
    if (!currentPassword) return c.json({ code: "invalid_password" }, 400);
    if (!newPassword || newPassword.length < 8) return c.json({ code: "invalid_password" }, 400);

    const rows = await db
      .select({ id: userTable.id, passwordHash: userTable.passwordHash })
      .from(userTable)
      .where(eq(userTable.id, authUser.id))
      .limit(1);
    if (rows.length === 0) return c.json({ code: "unauthorized" }, 401);
    const u = rows[0]!;

    if (!(await verifyPassword(currentPassword, u.passwordHash)))
      return c.json({ code: "invalid_credentials" }, 401);

    const nowMs = Date.now();
    const passwordHash = await hashPassword(newPassword);

    await db
      .update(userTable)
      .set({ passwordHash, updatedAtMs: nowMs })
      .where(eq(userTable.id, u.id));

    await revokeUserSessions(db, u.id, nowMs);
    touchThrottler.evictAll();
    c.get("liveHub")?.disconnectByUser(u.id);

    const secure = isSecureRequest(c.req.raw, c.env.connectionIp);
    deleteCookie(c, SESSION_COOKIE_NAME, {
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "Strict",
    });
    return c.json({ ok: true });
  });

  router.get("/logs", async (c) => {
    const limit = Math.min(parsePositiveIntQuery(c.req.query("limit")) ?? 200, 2000);
    const sinceTsMs = parseNonNegativeIntQuery(c.req.query("sinceTsMs"));
    const entries = logBuffer.list({
      sinceTsMs: sinceTsMs ?? undefined,
      limit,
    });
    return c.json({ nowMs: Date.now(), entries });
  });
}
