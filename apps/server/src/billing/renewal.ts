import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { AgentRegistry } from "../agents/registry";
import type { DbClient } from "../db/client";
import { agentPricing, agentStatus } from "../db/schema";
import type { BrowserLiveHub } from "../live/hub";
import { startIntervalTask } from "../util/interval-task";
import { getPricingCycleMonths, RENEWABLE_PRICING_CYCLES } from "./pricing-cycles";

const RENEWAL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RECENTLY_SEEN_MS = 72 * 60 * 60 * 1000; // 72 hours

export function addMonthsUtc(tsMs: number, months: number): number {
  const d = new Date(tsMs);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // If the day overflowed (e.g. 31 → 3), clamp to last day of target month
  if (d.getUTCDate() !== day) {
    d.setUTCDate(0); // back to last day of previous month
  }
  return d.getTime();
}

export function advanceExpiry(expiresAtMs: number, cycle: string, nowMs: number): number | null {
  const months = getPricingCycleMonths(cycle);
  if (months === null) return null;
  let n = 0;
  let ts = expiresAtMs;
  while (ts <= nowMs) {
    n++;
    ts = addMonthsUtc(expiresAtMs, months * n);
  }
  return ts;
}

type ExpiredRow = {
  agentId: string;
  expiresAtMs: number | null;
  cycle: string;
  lastSeenAtMs: number | null;
};

async function loadExpiredAgents(db: DbClient, nowMs: number): Promise<ExpiredRow[]> {
  return db
    .select({
      agentId: agentPricing.agentId,
      expiresAtMs: agentPricing.expiresAtMs,
      cycle: agentPricing.cycle,
      lastSeenAtMs: agentStatus.lastSeenAtMs,
    })
    .from(agentPricing)
    .innerJoin(agentStatus, eq(agentPricing.agentId, agentStatus.agentId))
    .where(
      and(
        isNotNull(agentPricing.expiresAtMs),
        lt(agentPricing.expiresAtMs, nowMs),
        inArray(agentPricing.cycle, RENEWABLE_PRICING_CYCLES),
      ),
    );
}

export type RenewExpiredAgentsDeps = {
  db: DbClient;
  registry: AgentRegistry;
  liveHub?: BrowserLiveHub;
};

export async function renewExpiredAgents(
  deps: RenewExpiredAgentsDeps,
  nowMs: number = Date.now(),
): Promise<number> {
  const rows = await loadExpiredAgents(deps.db, nowMs);
  const recentThreshold = nowMs - RECENTLY_SEEN_MS;

  let renewedCount = 0;
  const broadcastIds: string[] = [];
  for (const row of rows) {
    if (row.expiresAtMs === null) continue;
    if (row.lastSeenAtMs === null || row.lastSeenAtMs < recentThreshold) continue;

    const newExpiry = advanceExpiry(row.expiresAtMs, row.cycle, nowMs);
    if (newExpiry === null) continue;

    // Conditional update on the old expiry value keeps the DB safe if a PATCH
    // /agents/:id/pricing commits concurrently — we won't clobber a just-
    // written value.
    const updated = await deps.db
      .update(agentPricing)
      .set({ expiresAtMs: newExpiry, updatedAtMs: nowMs })
      .where(
        and(eq(agentPricing.agentId, row.agentId), eq(agentPricing.expiresAtMs, row.expiresAtMs)),
      )
      .returning({ agentId: agentPricing.agentId });

    if (updated.length === 0) continue;
    renewedCount++;

    if (await deps.registry.syncPricingFromDb(row.agentId)) {
      broadcastIds.push(row.agentId);
    }
  }

  if (broadcastIds.length > 0) {
    deps.liveHub?.publishAgentChanges(broadcastIds);
  }

  return renewedCount;
}

export function startPricingRenewalWorker(deps: RenewExpiredAgentsDeps) {
  return startIntervalTask({
    label: "pricing renewal",
    intervalMs: RENEWAL_INTERVAL_MS,
    tick: async () => {
      const renewed = await renewExpiredAgents(deps);
      if (renewed > 0) {
        console.log(`pricing renewal: auto-renewed ${renewed} agent(s)`);
      }
    },
  });
}
