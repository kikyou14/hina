import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AppContext } from "../../app";
import { type LoginAttemptReason, recordLoginAttempt } from "../../auth/login-attempts";
import { getDummyPasswordHash, verifyPassword } from "../../auth/password";
import {
  SESSION_COOKIE_NAME,
  type SessionTouchThrottler,
  createSession,
  revokeSession,
} from "../../auth/session";
import { ADMIN_SESSION_TTL_MS } from "../../config";
import { user as userTable } from "../../db/schema";
import { createLogger } from "../../logging/logger";
import { isSecureRequest } from "../../util/http";
import { resolveClientIp } from "../../util/trust-proxy";
import { isRecord } from "./parsing";
import { getEffectiveTtlMs } from "./shared";

const authLog = createLogger("auth");

const loginBodyLimit = bodyLimit({
  maxSize: 4 * 1024,
  onError: (c) => c.json({ code: "payload_too_large" } as const, 413),
});

const loginLimiter = rateLimiter<AppContext>({
  windowMs: 60_000,
  limit: 5,
  keyGenerator: (c) => resolveClientIp(c.req.raw, c.env.connectionIp) ?? "unknown",
  standardHeaders: "draft-7",
  message: { code: "rate_limit_exceeded" },
});

export function registerAdminLoginRoutes(router: Hono<AppContext>) {
  router.post("/session/login", loginLimiter, loginBodyLimit, async (c) => {
    const db = c.get("db");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const username = typeof body["username"] === "string" ? body["username"].trim() : "";
    const password = typeof body["password"] === "string" ? body["password"] : "";
    const mode = typeof body["mode"] === "string" ? body["mode"] : "";
    const clientIp = resolveClientIp(c.req.raw, c.env.connectionIp);
    const userAgent = c.req.header("user-agent") ?? null;

    if (!username || !password) return c.json({ code: "invalid_credentials" }, 401);

    const rows = await db
      .select({
        id: userTable.id,
        username: userTable.username,
        role: userTable.role,
        passwordHash: userTable.passwordHash,
      })
      .from(userTable)
      .where(eq(userTable.username, username))
      .limit(1);

    const nowMs = Date.now();

    const recordAttempt = async (args: {
      success: boolean;
      reason: LoginAttemptReason;
      userId: string | null;
    }) => {
      try {
        await recordLoginAttempt(db, {
          nowMs,
          ip: clientIp ?? null,
          userAgent,
          usernameAttempted: username,
          ...args,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        authLog.warn(`login_attempt record failed: ${msg}`);
      }
    };

    const u = rows[0] ?? null;
    const hashToVerify = u?.passwordHash ?? (await getDummyPasswordHash());
    const passwordOk = await verifyPassword(password, hashToVerify);

    if (!u || !passwordOk) {
      authLog.warn(`login failed: user=${username} ip=${clientIp ?? "unknown"}`);
      await recordAttempt({
        success: false,
        reason: u ? "bad_password" : "no_user",
        userId: u?.id ?? null,
      });
      return c.json({ code: "invalid_credentials" }, 401);
    }

    const ttlMs = getEffectiveTtlMs(ADMIN_SESSION_TTL_MS);
    const session = await createSession(db, {
      userId: u.id,
      nowMs,
      ttlMs,
      ip: clientIp,
      userAgent: userAgent ?? undefined,
    });
    authLog.info(`login ok: user=${username} ip=${clientIp ?? "unknown"}`);
    await recordAttempt({ success: true, reason: "ok", userId: u.id });

    await db
      .update(userTable)
      .set({ lastLoginAtMs: nowMs, updatedAtMs: nowMs })
      .where(eq(userTable.id, u.id));

    const secure = isSecureRequest(c.req.raw, c.env.connectionIp);
    setCookie(c, SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      secure,
      sameSite: "Strict",
      maxAge: Math.floor(ttlMs / 1000),
      path: "/",
    });

    const res: Record<string, unknown> = {
      ok: true,
      user: { id: u.id, username: u.username, role: u.role },
      expiresAtMs: session.expiresAtMs,
    };
    if (mode === "token") res["token"] = session.token;

    c.header("Cache-Control", "no-store");
    return c.json(res);
  });
}

export function registerAdminSessionRoutes(
  router: Hono<AppContext>,
  touchThrottler: SessionTouchThrottler,
) {
  router.get("/session/me", async (c) => {
    const user = c.get("authUser");
    return c.json({ ok: true, user: user ?? null });
  });

  router.post("/session/logout", async (c) => {
    const db = c.get("db");
    const tokenHash = c.get("sessionTokenHash") as string | undefined;
    if (tokenHash) {
      await revokeSession(db, tokenHash);
      touchThrottler.evict(tokenHash);
      c.get("liveHub")?.disconnectBySession(tokenHash);
    }
    const secure = isSecureRequest(c.req.raw, c.env.connectionIp);
    deleteCookie(c, SESSION_COOKIE_NAME, {
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "Strict",
    });
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true });
  });
}
