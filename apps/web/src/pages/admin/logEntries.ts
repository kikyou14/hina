import type { AdminLogEntry } from "@/api/adminLogs";

export const MAX_LOG_ENTRIES = 5000;

export function appendUniqueLogEntries(
  current: AdminLogEntry[],
  incoming: readonly AdminLogEntry[],
  maxEntries: number = MAX_LOG_ENTRIES,
): AdminLogEntry[] {
  if (incoming.length === 0) return current;

  const seenIds = new Set(current.map((entry) => entry.id));
  const uniqueEntries: AdminLogEntry[] = [];
  for (const entry of incoming) {
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    uniqueEntries.push(entry);
  }

  if (uniqueEntries.length === 0) return current;
  const merged = [...current, ...uniqueEntries];
  return merged.length <= maxEntries ? merged : merged.slice(merged.length - maxEntries);
}
