import type { Context } from "hono";
import type { AppContext } from "../app";
import { resolveClientIp } from "../util/trust-proxy";

export function publicIpKey(c: Context<AppContext>): string {
  return resolveClientIp(c.req.raw, c.env.connectionIp) ?? "unknown";
}

export function authUserOrIpKey(c: Context<AppContext>): string {
  const user = c.get("authUser");
  if (user) return `user:${user.id}`;
  return resolveClientIp(c.req.raw, c.env.connectionIp) ?? "unknown";
}
