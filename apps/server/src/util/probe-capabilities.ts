import { isRecord } from "./lang";

export function capabilitySupportsTracerouteTcpSizePair(cap: unknown): boolean {
  if (!isRecord(cap)) return false;
  const probes = cap["probes"];
  if (!isRecord(probes)) return false;
  const traceroute = probes["traceroute"];
  return isRecord(traceroute) && traceroute["tcpSizePair"] === true;
}

export function capabilitySupportsTcpPacketSize(cap: unknown): boolean {
  if (!isRecord(cap)) return false;
  const probes = cap["probes"];
  if (!isRecord(probes)) return false;
  const tcp = probes["tcp"];
  return isRecord(tcp) && tcp["packetSize"] === true;
}
