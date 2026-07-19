import type { ProbeKind, ProbeTaskTarget } from "@/api/adminProbes";

export const SELECT_ALL_VALUE = "__all__";

const HOSTNAME_RE = /^(?!-)([a-zA-Z0-9-]{1,63}(?<!-)\.)*[a-zA-Z]{2,63}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv6Literal(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return unwrapped.includes(":") && !unwrapped.includes("/");
}

export function isValidHost(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (s.includes(":")) return true;
  const m = IPV4_RE.exec(s);
  if (m) return m.slice(1).every((p) => Number(p) <= 255);
  return HOSTNAME_RE.test(s);
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export type ProbeTaskFormValue = {
  name: string;
  kind: ProbeKind;
  target: ProbeTaskTarget;
  intervalSec: number;
  timeoutMs: number;
  enabled: boolean;
  allAgents: boolean;
  traceRevealHopDetails: boolean;
  groupIds: string[];
  agentIds: string[];
};

export type TracerouteProtocol = "icmp" | "tcp";

export type TcpTracerouteTarget = {
  host: string;
  protocol: "tcp";
  port: number;
  packetSizes: [number, number];
};

export function isTcpTracerouteTarget(
  target: ProbeTaskTarget | null | undefined,
): target is TcpTracerouteTarget {
  if (!target) return false;
  const record = target as Record<string, unknown>;
  return record["protocol"] === "tcp" && Array.isArray(record["packetSizes"]);
}

export function tracerouteProtocolOfTarget(
  target: ProbeTaskTarget | null | undefined,
): TracerouteProtocol {
  return isTcpTracerouteTarget(target) ? "tcp" : "icmp";
}

export function parseIntegerInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isInteger(value) ? value : null;
}

export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

export const TRACEROUTE_TCP_PACKET_SIZE_MIN = 40;
export const TRACEROUTE_TCP_PACKET_SIZE_MAX = 1500;

export function isValidTracerouteTcpPacketSize(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= TRACEROUTE_TCP_PACKET_SIZE_MIN &&
    value <= TRACEROUTE_TCP_PACKET_SIZE_MAX
  );
}

export function parseTracerouteTcpPacketSizes(
  small: number,
  large: number,
): [number, number] | null {
  if (!isValidTracerouteTcpPacketSize(small) || !isValidTracerouteTcpPacketSize(large)) {
    return null;
  }
  if (small === large) return null;
  return small < large ? [small, large] : [large, small];
}
