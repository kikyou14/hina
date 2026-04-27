import { rateLimiter } from "hono-rate-limiter";
import type { AppContext } from "../app";
import { authUserOrIpKey, publicIpKey } from "./keys";
import * as tiers from "./tiers";

const RATE_LIMIT_MESSAGE = { code: "rate_limit_exceeded" } as const;

type Tier = { windowMs: number; limit: number };

function createPublicLimiter(tier: Tier) {
  return rateLimiter<AppContext>({
    windowMs: tier.windowMs,
    limit: tier.limit,
    keyGenerator: publicIpKey,
    standardHeaders: "draft-7",
    message: RATE_LIMIT_MESSAGE,
  });
}

function createSmartLimiter(anon: Tier, auth: Tier) {
  if (anon.windowMs !== auth.windowMs) {
    throw new Error("smart limiter requires equal windowMs for both tiers");
  }
  return rateLimiter<AppContext>({
    windowMs: anon.windowMs,
    limit: (c) => (c.get("authUser") ? auth.limit : anon.limit),
    keyGenerator: authUserOrIpKey,
    standardHeaders: "draft-7",
    message: RATE_LIMIT_MESSAGE,
  });
}

export const publicGlobal = createPublicLimiter(tiers.PUBLIC_GLOBAL);

export const publicStd = createSmartLimiter(tiers.PUBLIC_STD, tiers.AUTH_STD);
export const publicHeavy = createSmartLimiter(tiers.PUBLIC_HEAVY, tiers.AUTH_HEAVY);
