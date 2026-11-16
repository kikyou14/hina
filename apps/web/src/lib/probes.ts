import type { ProbeKind, ProbeTaskTarget } from "@/api/adminProbes";

/** `host:port`, bracketing IPv6 literals so the port stays unambiguous. */
function hostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function formatProbeTarget(
  kind: ProbeKind | null | undefined,
  target: ProbeTaskTarget | null,
): string {
  if (!kind || !target) return "-";
  const record = target as Record<string, unknown>;
  if (kind === "http") {
    return typeof record["url"] === "string" ? (record["url"] as string) : "-";
  }
  const host = record["host"];
  if (typeof host !== "string") return "-";

  const parts: string[] = [];
  if (kind === "tcp" || (kind === "traceroute" && record["protocol"] === "tcp")) {
    const port = record["port"];
    if (typeof port !== "number") return "-";
    parts.push(hostPort(host, port));
  } else {
    parts.push(host);
  }
  if (record["family"] === "ipv4") parts.push("IPv4");
  if (record["family"] === "ipv6") parts.push("IPv6");
  if (kind === "tcp" && typeof record["packetSize"] === "number") {
    parts.push(`${record["packetSize"]}B`);
  }
  return parts.join(" · ");
}
