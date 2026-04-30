import type { PublicAgentSummary } from "@/api/public";
import { formatBytes, formatPricing } from "@/lib/format";
import { getMetricNumber } from "@/lib/metrics";
import { formatDurationCompact, getDisplayedUptimeSeconds } from "@/lib/time";

export type StaticAgentMetrics = {
  cpuPct: number | null;
  memUsed: number | null;
  memTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  txRate: number | null;
  rxRate: number | null;
  memPct: number | null;
  diskPct: number | null;
  trafficPct: number | null;

  countryCode: string | null;
  pricingLabel: string | null;

  memValue: string;
  diskValue: string;
  trafficValue: string;
};

export type AgentExpiryKey = "none" | "expired" | `active:${number}`;

function getAgentUptimeSeconds(a: PublicAgentSummary, nowMs: number): number | null {
  return getDisplayedUptimeSeconds({
    online: a.status.online,
    lastSeenAtMs: a.status.lastSeenAtMs,
    uptimeSec: a.latest?.uptimeSec,
    nowMs,
  });
}

export function computeStaticAgentMetrics(a: PublicAgentSummary): StaticAgentMetrics {
  const m = a.latest?.m ?? null;

  const cpuPct = getMetricNumber(m, "cpu.usage_pct");
  const memUsed = getMetricNumber(m, "mem.used_bytes");
  const memTotal = getMetricNumber(m, "mem.total_bytes");
  const diskUsed = getMetricNumber(m, "disk.used_bytes");
  const diskTotal = getMetricNumber(m, "disk.total_bytes");
  const txRate = getMetricNumber(m, "net.tx_rate");
  const rxRate = getMetricNumber(m, "net.rx_rate");

  const memPct =
    memUsed !== null && memTotal !== null && memTotal > 0 ? (memUsed / memTotal) * 100 : null;
  const diskPct =
    diskUsed !== null && diskTotal !== null && diskTotal > 0 ? (diskUsed / diskTotal) * 100 : null;
  const trafficPct =
    a.billing && a.billing.quotaBytes > 0
      ? (a.billing.usedBytes / a.billing.quotaBytes) * 100
      : null;

  const countryCode = a.geo.countryCode ?? null;

  const pricingLabel = a.pricing && a.pricing.amountUnit > 0 ? formatPricing(a.pricing) : null;

  const memValue =
    memUsed !== null && memTotal !== null
      ? `${formatBytes(memUsed)} / ${formatBytes(memTotal)}`
      : "-";
  const diskValue =
    diskUsed !== null && diskTotal !== null
      ? `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`
      : "-";
  const trafficValue =
    a.billing && a.billing.quotaBytes > 0
      ? `${formatBytes(a.billing.usedBytes)} / ${formatBytes(a.billing.quotaBytes)}`
      : "-";

  return {
    cpuPct,
    memUsed,
    memTotal,
    diskUsed,
    diskTotal,
    txRate,
    rxRate,
    memPct,
    diskPct,
    trafficPct,
    countryCode,
    pricingLabel,
    memValue,
    diskValue,
    trafficValue,
  };
}

export function computeAgentUptime(a: PublicAgentSummary, nowMs: number): string {
  return formatDurationCompact(getAgentUptimeSeconds(a, nowMs));
}

export function computeAgentUptimeDays(a: PublicAgentSummary, nowMs: number): number {
  const uptimeSeconds = getAgentUptimeSeconds(a, nowMs);
  if (uptimeSeconds === null) return 0;
  return Math.floor(uptimeSeconds / 86_400);
}

export function computeAgentExpiryKey(a: PublicAgentSummary, nowMs: number): AgentExpiryKey {
  const expiresAtMs = a.pricing?.expiresAtMs;
  if (expiresAtMs === null || expiresAtMs === undefined) return "none";
  if (expiresAtMs > nowMs) {
    return `active:${Math.floor((expiresAtMs - nowMs) / 86_400_000)}`;
  }
  return "expired";
}

export function getAgentExpiryDays(expiryKey: AgentExpiryKey): number | null {
  if (!expiryKey.startsWith("active:")) return null;
  return Number.parseInt(expiryKey.slice("active:".length), 10);
}

export function computeDaysUntilReset(resetDay: number, nowMs: number): number | null {
  if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31) return null;

  const now = new Date(nowMs);
  const yyyy = now.getUTCFullYear();
  const mm = now.getUTCMonth(); // 0-indexed
  const todayUtcMs = Date.UTC(yyyy, mm, now.getUTCDate());

  const effectiveResetUtcMs = (y: number, m: number): number => {
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return resetDay <= lastDay ? Date.UTC(y, m, resetDay) : Date.UTC(y, m + 1, 1);
  };

  const thisMonthReset = effectiveResetUtcMs(yyyy, mm);
  const nextResetMs =
    thisMonthReset > todayUtcMs ? thisMonthReset : effectiveResetUtcMs(yyyy, mm + 1);

  return Math.floor((nextResetMs - todayUtcMs) / 86_400_000);
}
