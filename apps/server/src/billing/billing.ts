export type BillingMode = "sum" | "rx" | "tx" | "max";

export type BillingConfig = {
  quotaBytes: number;
  mode: BillingMode;
  resetDay: number;
};

export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  quotaBytes: 0,
  mode: "sum",
  resetDay: 1,
};

export function parseBillingMode(value: unknown): BillingMode | null {
  if (value === "sum" || value === "rx" || value === "tx" || value === "max") return value;
  return null;
}

export function parseResetDay(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (value < 1 || value > 31) return null;
  return value;
}

export function parseQuotaBytes(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isSafeInteger(value)) return null;
  if (value < 0) return null;
  return value;
}

export function normalizeBillingConfig(input: {
  quotaBytes?: unknown;
  mode?: unknown;
  resetDay?: unknown;
}): BillingConfig {
  const quotaBytes = parseQuotaBytes(input.quotaBytes) ?? DEFAULT_BILLING_CONFIG.quotaBytes;
  const mode = parseBillingMode(input.mode) ?? DEFAULT_BILLING_CONFIG.mode;
  const resetDay = parseResetDay(input.resetDay) ?? DEFAULT_BILLING_CONFIG.resetDay;
  return { quotaBytes, mode, resetDay };
}

export function toYyyyMmDdUtc(tsMs: number): number {
  const d = new Date(tsMs);
  const yyyy = d.getUTCFullYear();
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  return yyyy * 10000 + mm * 100 + dd;
}

function daysInMonthUtc(yyyy: number, mm: number): number {
  return new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
}

function effectiveResetYyyyMmDd(yyyy: number, mm: number, resetDay: number): number {
  if (resetDay <= daysInMonthUtc(yyyy, mm)) {
    return yyyy * 10000 + mm * 100 + resetDay;
  }
  // Overflow: use 1st of the next month
  let nextMm = mm + 1;
  let nextYyyy = yyyy;
  if (nextMm > 12) {
    nextMm = 1;
    nextYyyy += 1;
  }
  return nextYyyy * 10000 + nextMm * 100 + 1;
}

export function computePeriodStartYyyyMmDdUtc(nowMs: number, resetDay: number): number {
  const now = new Date(nowMs);
  const yyyy = now.getUTCFullYear();
  const mm = now.getUTCMonth() + 1;
  const todayDay = yyyy * 10000 + mm * 100 + now.getUTCDate();

  const currentReset = effectiveResetYyyyMmDd(yyyy, mm, resetDay);
  if (todayDay >= currentReset) return currentReset;

  // Before this month's effective reset — use previous month's
  let prevMm = mm - 1;
  let prevYyyy = yyyy;
  if (prevMm === 0) {
    prevMm = 12;
    prevYyyy -= 1;
  }
  return effectiveResetYyyyMmDd(prevYyyy, prevMm, resetDay);
}

export function computeUsedBytes(mode: BillingMode, rxBytes: number, txBytes: number): number {
  if (!Number.isSafeInteger(rxBytes) || rxBytes < 0) rxBytes = 0;
  if (!Number.isSafeInteger(txBytes) || txBytes < 0) txBytes = 0;

  switch (mode) {
    case "rx":
      return rxBytes;
    case "tx":
      return txBytes;
    case "max":
      return Math.max(rxBytes, txBytes);
    case "sum":
    default:
      return rxBytes + txBytes;
  }
}

export function computeOverQuota(quotaBytes: number, usedBytes: number): boolean {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0) return false;
  if (!Number.isSafeInteger(usedBytes) || usedBytes < 0) return false;
  return usedBytes >= quotaBytes;
}

export type AgentBillingResult = {
  quotaBytes: number;
  mode: BillingMode;
  resetDay: number;
  periodStartDayYyyyMmDd: number;
  periodEndDayYyyyMmDd: number;
  rxBytes: number;
  txBytes: number;
  usedBytes: number;
  overQuota: boolean;
};

export type AgentBillingInput = {
  id: string;
  billingQuotaBytes?: number | null;
  billingMode?: string | null;
  billingResetDay?: number | null;
};

export async function computeAgentsBilling(
  agents: AgentBillingInput[],
  nowMs: number,
  queryTrafficRows: (
    agentIds: string[],
    startDay: number,
    endDay: number,
  ) => Promise<
    Array<{
      agentId: string;
      dayYyyyMmDd: number;
      rxBytes: number;
      txBytes: number;
    }>
  >,
): Promise<Map<string, AgentBillingResult>> {
  const todayDay = toYyyyMmDdUtc(nowMs);

  const configByAgentId = new Map<
    string,
    { config: BillingConfig; periodStartDayYyyyMmDd: number }
  >();
  let earliestStartDay = todayDay;

  for (const a of agents) {
    const config = normalizeBillingConfig({
      quotaBytes: a.billingQuotaBytes ?? undefined,
      mode: a.billingMode ?? undefined,
      resetDay: a.billingResetDay ?? undefined,
    });
    const periodStartDayYyyyMmDd = computePeriodStartYyyyMmDdUtc(nowMs, config.resetDay);
    earliestStartDay = Math.min(earliestStartDay, periodStartDayYyyyMmDd);
    configByAgentId.set(a.id, { config, periodStartDayYyyyMmDd });
  }

  const trafficSums = new Map<string, { rxBytes: number; txBytes: number }>();
  const agentIds = agents.map((a) => a.id);

  if (agentIds.length > 0) {
    const trafficRows = await queryTrafficRows(agentIds, earliestStartDay, todayDay);
    for (const tr of trafficRows) {
      const start = configByAgentId.get(tr.agentId)?.periodStartDayYyyyMmDd ?? earliestStartDay;
      if (tr.dayYyyyMmDd < start) continue;
      const existing = trafficSums.get(tr.agentId) ?? {
        rxBytes: 0,
        txBytes: 0,
      };
      existing.rxBytes += tr.rxBytes;
      existing.txBytes += tr.txBytes;
      trafficSums.set(tr.agentId, existing);
    }
  }

  const results = new Map<string, AgentBillingResult>();
  for (const a of agents) {
    const entry = configByAgentId.get(a.id)!;
    const traffic = trafficSums.get(a.id) ?? { rxBytes: 0, txBytes: 0 };
    const usedBytes = computeUsedBytes(entry.config.mode, traffic.rxBytes, traffic.txBytes);
    const over = computeOverQuota(entry.config.quotaBytes, usedBytes);
    results.set(a.id, {
      quotaBytes: entry.config.quotaBytes,
      mode: entry.config.mode,
      resetDay: entry.config.resetDay,
      periodStartDayYyyyMmDd: entry.periodStartDayYyyyMmDd,
      periodEndDayYyyyMmDd: todayDay,
      rxBytes: traffic.rxBytes,
      txBytes: traffic.txBytes,
      usedBytes,
      overQuota: over,
    });
  }

  return results;
}
