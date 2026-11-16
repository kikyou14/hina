import type { AdminAgentOption } from "@/api/adminAgents";
import type { AddressFamily, ProbeCapability, ProbeKind, ProbeTaskTarget } from "@/api/adminProbes";
import type { ScopeState } from "@/components/ScopeSelector";

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

export function isIpv4Literal(value: string): boolean {
  const m = IPV4_RE.exec(value.trim());
  return m !== null && m.slice(1).every((p) => Number(p) <= 255);
}

export function isValidHost(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (s.includes(":")) return true;
  if (IPV4_RE.test(s)) return isIpv4Literal(s);
  return HOSTNAME_RE.test(s);
}

/** `auto` leaves the address family to the agent. */
export type FamilyChoice = "auto" | AddressFamily;

export function familyOfTarget(target: ProbeTaskTarget | null | undefined): FamilyChoice {
  if (!target || !("family" in target)) return "auto";
  return target.family === "ipv4" || target.family === "ipv6" ? target.family : "auto";
}

export function withFamily<T extends object>(
  target: T,
  family: FamilyChoice,
): T & { family?: AddressFamily } {
  return family === "auto" ? target : { ...target, family };
}

/** Whether an explicit family contradicts an IP literal host. */
export function familyConflictsWithHost(host: string, family: FamilyChoice): boolean {
  if (family === "auto") return false;
  return family === "ipv4" ? isIpv6Literal(host) : isIpv4Literal(host);
}

/** Family a raw TCP probe sends over: the chosen one, else an IPv6 literal's, else IPv4. */
export function rawTcpFamily(host: string, family: FamilyChoice): AddressFamily {
  if (family !== "auto") return family;
  return isIpv6Literal(host) ? "ipv6" : "ipv4";
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
  family?: AddressFamily;
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

/** Smallest raw TCP probe: the fixed IP header plus a bare 20-byte TCP header. */
export const TCP_PACKET_SIZE_MIN: Record<AddressFamily, number> = { ipv4: 40, ipv6: 60 };
export const TCP_PACKET_SIZE_MAX = 1500;

export function isValidTcpPacketSize(value: number, family: AddressFamily): boolean {
  return (
    Number.isInteger(value) && value >= TCP_PACKET_SIZE_MIN[family] && value <= TCP_PACKET_SIZE_MAX
  );
}

export function parseTracerouteTcpPacketSizes(
  small: number,
  large: number,
  family: AddressFamily,
): [number, number] | null {
  if (!isValidTcpPacketSize(small, family) || !isValidTcpPacketSize(large, family)) {
    return null;
  }
  if (small === large) return null;
  return small < large ? [small, large] : [large, small];
}

export function tcpPacketSizeOfTarget(target: ProbeTaskTarget | null | undefined): number | null {
  if (!target || !("packetSize" in target)) return null;
  return typeof target.packetSize === "number" ? target.packetSize : null;
}

/** The only TCP packet sizes agents accepted before arbitrary sizes and IPv6. */
const LEGACY_TCP_PACKET_SIZES: ReadonlySet<number> = new Set([40, 1200]);

/** Mirrors the server's gating so the form can warn before saving; empty for baseline probes. */
export function requiredProbeCapabilities(
  kind: ProbeKind,
  target: ProbeTaskTarget | null,
): ProbeCapability[] {
  if (!target || !("host" in target)) return [];
  const required: ProbeCapability[] = [];
  const family = familyOfTarget(target);
  if (family !== "auto") required.push("addressFamily");

  if (kind === "tcp" && "packetSize" in target && target.packetSize !== undefined) {
    required.push("tcpPacketSize");
    if (!LEGACY_TCP_PACKET_SIZES.has(target.packetSize)) required.push("tcpPacketSizeRange");
    if (rawTcpFamily(target.host, family) === "ipv6") required.push("tcpPacketSizeIpv6");
  } else if (kind === "traceroute" && isTcpTracerouteTarget(target)) {
    required.push("tracerouteTcpSizePair");
    if (rawTcpFamily(target.host, family) === "ipv6") required.push("tracerouteTcpSizePairIpv6");
  } else if (
    kind === "traceroute" &&
    (family === "ipv6" || (family === "auto" && isIpv6Literal(target.host)))
  ) {
    required.push("tracerouteIcmpIpv6");
  }
  return required;
}

/** Agents in `scope`, and how many of them advertise every `required` capability. */
export function probeCapabilitySupport(
  agents: AdminAgentOption[],
  scope: ScopeState,
  required: readonly ProbeCapability[],
) {
  const selected = agents.filter(
    (agent) =>
      scope.mode === "all" ||
      (scope.mode === "groups"
        ? agent.groupId !== null && scope.groupIds.includes(agent.groupId)
        : scope.agentIds.includes(agent.id)),
  );
  return {
    total: selected.length,
    supported: selected.filter((agent) =>
      required.every((capability) => agent.probeCapabilities.includes(capability)),
    ).length,
  };
}
