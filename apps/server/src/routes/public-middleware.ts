import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import type { AppContext } from "../app";
import {
  SESSION_COOKIE_NAME,
  SessionTouchThrottler,
  hashSessionToken,
  parseBearerToken,
} from "../auth/session";

export function createResolveOptionalSession(
  touchThrottler: SessionTouchThrottler,
): MiddlewareHandler<AppContext> {
  return async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Vary", "Cookie, Authorization");

    const bearer = parseBearerToken(c.req.header("authorization") ?? null);
    const cookieTok = getCookie(c, SESSION_COOKIE_NAME);
    const token = bearer ?? cookieTok ?? null;
    if (!token) {
      await next();
      return;
    }

    const db = c.get("db");
    const nowMs = Date.now();
    const tokenHash = hashSessionToken(token);
    const session = await touchThrottler.validateAndTouch(db, { tokenHash, nowMs });
    if (!session || session.user.role !== "admin") {
      await next();
      return;
    }

    c.set("authUser", session.user);
    c.set("sessionTokenHash", tokenHash);
    await next();
  };
}
