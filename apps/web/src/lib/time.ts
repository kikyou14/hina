export function formatTimeAgo(tsMs: number | null | undefined, nowMs: number): string {
  if (!tsMs || !Number.isFinite(tsMs)) return "-";
  const delta = Math.max(0, nowMs - tsMs);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
  return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`;
}

export function formatIsoShort(tsMs: number | null | undefined, timezone?: string): string {
  if (!tsMs || !Number.isFinite(tsMs)) return "-";
  return new Date(tsMs).toLocaleString("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function getDisplayedUptimeSeconds(args: {
  online: boolean;
  lastSeenAtMs: number | null | undefined;
  uptimeSec: number | null | undefined;
  nowMs: number;
}): number | null {
  const { online, lastSeenAtMs, uptimeSec, nowMs } = args;
  if (uptimeSec === null || uptimeSec === undefined) return null;
  if (!Number.isFinite(uptimeSec) || uptimeSec < 0) return null;

  const baseSeconds = Math.floor(uptimeSec);
  if (!online) return baseSeconds;
  if (!lastSeenAtMs || !Number.isFinite(lastSeenAtMs)) return baseSeconds;

  const deltaSeconds = Math.max(0, Math.floor((nowMs - lastSeenAtMs) / 1000));
  return baseSeconds + deltaSeconds;
}

export function formatDurationCompact(totalSeconds: number | null | undefined): string {
  if (totalSeconds === null || totalSeconds === undefined) return "-";
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "-";

  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const restSeconds = seconds % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return restSeconds > 0 ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  return `${restSeconds}s`;
}
