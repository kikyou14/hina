import type { ProbeKind, ProbeTaskTarget } from "@/api/adminProbes";

export function formatProbeTarget(
  kind: ProbeKind | null | undefined,
  target: ProbeTaskTarget | null,
): string {
  if (!kind || !target) return "-";
  const record = target as Record<string, unknown>;
  if (kind === "http") {
    return typeof record["url"] === "string" ? (record["url"] as string) : "-";
  }
  if (kind === "tcp") {
    return typeof record["host"] === "string" && typeof record["port"] === "number"
      ? `${record["host"]}:${record["port"]}`
      : "-";
  }
  return typeof record["host"] === "string" ? (record["host"] as string) : "-";
}
