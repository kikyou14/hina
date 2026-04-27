const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

export type TelemetryTierPolicy = {
  intervalSec: number;
  retentionMs: number;
  deleteChunkMs: number;
};

export const telemetryTierPolicies: readonly TelemetryTierPolicy[] = [
  {
    // Live (3-minute) window.
    intervalSec: 4,
    retentionMs: 10 * MIN_MS,
    deleteChunkMs: 10 * MIN_MS,
  },
  {
    // 4H and 1D windows.
    intervalSec: 60,
    retentionMs: 3 * DAY_MS,
    deleteChunkMs: 6 * HOUR_MS,
  },
  {
    // 7D window.
    intervalSec: 600,
    retentionMs: 8 * DAY_MS,
    deleteChunkMs: DAY_MS,
  },
  {
    // 30D window.
    intervalSec: 3600,
    retentionMs: 31 * DAY_MS,
    deleteChunkMs: 2 * DAY_MS,
  },
];

export function listTelemetryIntervalsSec(rangeMs?: number): number[] {
  if (rangeMs === undefined) {
    return telemetryTierPolicies.map((tier) => tier.intervalSec);
  }
  return telemetryTierPolicies
    .filter((tier) => tier.retentionMs >= rangeMs)
    .map((tier) => tier.intervalSec);
}
