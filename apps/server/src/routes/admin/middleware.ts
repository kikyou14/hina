import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppContext } from "../../app";
import {
  SESSION_COOKIE_NAME,
  type SessionTouchThrottler,
  hashSessionToken,
  parseBearerToken,
} from "../../auth/session";
import { createLogger } from "../../logging/logger";
import { checkRequestOrigin } from "../../util/origin";

const adminLog = createLogger("admin");

const UNSAFE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createOriginGuard(): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    if (!UNSAFE_METHODS.has(c.req.method)) return next();

    const hasBearer = parseBearerToken(c.req.header("authorization") ?? null) !== null;
    const cookieToken = getCookie(c, SESSION_COOKIE_NAME);
    if (hasBearer && cookieToken === undefined) return next();

    const result = checkRequestOrigin(c.req.raw, { peerIp: c.env.connectionIp });
    if (result.ok) return next();

    adminLog.warn(
      `rejecting ${c.req.method} ${c.req.path}: reason=${result.reason} ` +
        `origin=${result.origin ?? "<missing>"}`,
    );
    if (result.hint) adminLog.info(`hint: ${result.hint}`);
    return c.json({ code: "forbidden_origin" } as const, 403);
  };
}

export function createRequireAdmin(
  touchThrottler: SessionTouchThrottler,
): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    const db = c.get("db");
    const nowMs = Date.now();

    const bearer = parseBearerToken(c.req.header("authorization") ?? null);
    const cookieTok = getCookie(c, SESSION_COOKIE_NAME);
    const token = bearer ?? cookieTok ?? null;
    if (!token) return c.json({ code: "unauthorized" }, 401);

    const tokenHash = hashSessionToken(token);
    const session = await touchThrottler.validateAndTouch(db, { tokenHash, nowMs });
    if (!session) return c.json({ code: "unauthorized" }, 401);
    if (session.user.role !== "admin") return c.json({ code: "forbidden" }, 403);

    c.set("authUser", session.user);
    c.set("sessionTokenHash", tokenHash);

    c.header("Cache-Control", "no-store");
    await next();
  };
}
