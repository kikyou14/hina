import { isIP } from "node:net";
import { isRecord } from "./lang";

/** Agent capability a task needs beyond the baseline probes; agents without one skip the task. */
export type ProbeCapability =
  | "addressFamily"
  | "tcpPacketSize"
  | "tcpPacketSizeRange"
  | "tcpPacketSizeIpv6"
  | "tracerouteTcpSizePair"
  | "tracerouteTcpSizePairIpv6"
  | "tracerouteIcmpIpv6";

export type AddressFamily = "ipv4" | "ipv6";

/** The only TCP packet sizes agents accepted before arbitrary sizes and IPv6. */
const LEGACY_TCP_PACKET_SIZES: ReadonlySet<unknown> = new Set([40, 1200]);

function entry(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const child = value[key];
  return isRecord(child) ? child : null;
}

/** Probe capabilities an agent's HELLO `cap` advertises; only literal `true` flags count. */
export function supportedProbeCapabilities(cap: unknown): Set<ProbeCapability> {
  const probes = entry(cap, "probes");
  const tcp = entry(probes, "tcp");
  const traceroute = entry(probes, "traceroute");
  const flags: Array<[ProbeCapability, unknown]> = [
    ["addressFamily", probes?.["family"]],
    ["tcpPacketSize", tcp?.["packetSize"]],
    ["tcpPacketSizeRange", tcp?.["packetSizeRange"]],
    ["tcpPacketSizeIpv6", tcp?.["packetSizeIpv6"]],
    ["tracerouteTcpSizePair", traceroute?.["tcpSizePair"]],
    ["tracerouteTcpSizePairIpv6", traceroute?.["tcpSizePairIpv6"]],
    ["tracerouteIcmpIpv6", traceroute?.["icmpIpv6"]],
  ];
  return new Set(flags.filter(([, value]) => value === true).map(([capability]) => capability));
}

/**
 * The family a target is pinned to: its `family`, else the family of an IP literal host, else IPv4
 * for raw TCP modes, which predate `family`. `null` leaves the choice to the agent.
 */
export function pinnedAddressFamily(
  target: Record<string, unknown>,
  rawTcp: boolean,
): AddressFamily | null {
  const family = target["family"];
  if (family === "ipv4" || family === "ipv6") return family;
  const host = target["host"];
  const literal = typeof host === "string" ? isIP(host) : 0;
  if (literal === 4) return "ipv4";
  if (literal === 6) return "ipv6";
  return rawTcp ? "ipv4" : null;
}

/** Every capability an agent needs to run the task; empty for baseline probes. */
export function requiredProbeCapabilities(kind: string, target: unknown): ProbeCapability[] {
  if (!isRecord(target)) return [];
  const required: ProbeCapability[] = [];
  // Agents that predate `family` ignore it and would probe whichever family they pick.
  if (target["family"] !== undefined) required.push("addressFamily");

  if (kind === "tcp" && target["packetSize"] !== undefined) {
    required.push("tcpPacketSize");
    if (!LEGACY_TCP_PACKET_SIZES.has(target["packetSize"])) required.push("tcpPacketSizeRange");
    if (pinnedAddressFamily(target, true) === "ipv6") required.push("tcpPacketSizeIpv6");
  } else if (kind === "traceroute" && target["protocol"] === "tcp") {
    required.push("tracerouteTcpSizePair");
    if (pinnedAddressFamily(target, true) === "ipv6") required.push("tracerouteTcpSizePairIpv6");
  } else if (kind === "traceroute" && pinnedAddressFamily(target, false) === "ipv6") {
    required.push("tracerouteIcmpIpv6");
  }
  return required;
}
