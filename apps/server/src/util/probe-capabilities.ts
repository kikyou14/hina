import { isRecord } from "./lang";

function probeCapability(cap: unknown, probe: string): Record<string, unknown> | null {
  if (!isRecord(cap)) return null;
  const probes = cap["probes"];
  if (!isRecord(probes)) return null;
  const entry = probes[probe];
  return isRecord(entry) ? entry : null;
}

export function capabilitySupportsTracerouteTcpSizePair(cap: unknown): boolean {
  return probeCapability(cap, "traceroute")?.["tcpSizePair"] === true;
}

export function capabilitySupportsTracerouteIcmpIpv6(cap: unknown): boolean {
  return probeCapability(cap, "traceroute")?.["icmpIpv6"] === true;
}

export function capabilitySupportsTcpPacketSize(cap: unknown): boolean {
  return probeCapability(cap, "tcp")?.["packetSize"] === true;
}
