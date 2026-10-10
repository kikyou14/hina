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
  if (kind === "tcp" || (kind === "traceroute" && record["protocol"] === "tcp")) {
    return typeof record["host"] === "string" && typeof record["port"] === "number"
      ? `${record["host"]}:${record["port"]}${kind === "tcp" && (record["packetSize"] === 40 || record["packetSize"] === 1200) ? ` · ${record["packetSize"]}B` : ""}`
      : "-";
  }
  return typeof record["host"] === "string" ? (record["host"] as string) : "-";
}

export type TcpProbeExtra = { packet_size_bytes: 40 | 1200 };

export function parseTcpProbeExtra(extra: unknown): TcpProbeExtra | null {
  if (typeof extra !== "object" || extra === null || !("packet_size_bytes" in extra)) return null;
  const size = extra.packet_size_bytes;
  return size === 40 || size === 1200 ? { packet_size_bytes: size } : null;
}

export function tcpProbeErrorKey(error: string | null): string | null {
  switch (error) {
    case "timeout":
    case "connection_refused":
    case "permission_denied":
    case "connect_failed":
    case "packet_too_large":
    case "dest_unreachable":
    case "ipv6_not_supported":
    case "unsupported_platform":
    case "dns_lookup_failed":
    case "dns_no_records":
      return `probes.tcpResult.errors.${error}`;
    default:
      return null;
  }
}
