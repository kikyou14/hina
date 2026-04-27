import type { Context } from "hono";
import type { AppContext } from "../../app";
import type { ProbeDispatcher } from "../../ws/hub";

export function getEffectiveTtlMs(configTtlMs: number): number {
  const maxMs = 400 * 24 * 60 * 60 * 1000;
  return Math.min(Math.max(0, configTtlMs), maxMs);
}

export function getProbeDispatcher(c: Context<AppContext>): ProbeDispatcher | undefined {
  return c.get("probeDispatcher");
}
