import { isRecord } from "@/lib/typeGuards";

export type TracerouteAsnInfo = {
  asn: number;
  prefix: string;
  country_code: string;
  registry: string;
  name: string;
};

export type TracerouteExtraV1 = {
  kind: "traceroute";
  v: 1;
  target: string | null;
  target_ip: string | null;
  origin_ip: string | null;
  destination_asn_info: TracerouteAsnInfo | null;
  destination_reached: boolean;
  total_duration_ms: number;
  avg_rtt_ms: number | null;
  protocol_used: string;
  socket_mode_used: string;
  start_ttl: number;
  max_hops: number;
  queries_per_hop: number;
  hops: Array<{
    ttl: number;
    responses: Array<{
      ip: string | null;
      hostname: string | null;
      asn_info: TracerouteAsnInfo | null;
      rtt_ms: number | null;
    }>;
    timeouts: number;
  }>;
};

export type TracerouteExtraV2 = {
  kind: "traceroute";
  v: 2;
  target: string | null;
  target_ip: string | null;
  origin_ip: string | null;
  destination_asn_info: TracerouteAsnInfo | null;
  protocol_used: string;
  socket_mode_used: string;
  probe_style: string;
  port: number;
  start_ttl: number;
  max_hops: number;
  queries_per_hop: number;
  total_duration_ms: number;
  traces: Array<{
    packet_size_bytes: number | null;
    destination_reached: boolean;
    avg_rtt_ms: number | null;
    error_code: string | null;
    path_mtu_bytes: number | null;
    frag_hop_ttl: number | null;
    hops: TracerouteExtraV1["hops"];
  }>;
  comparison: {
    comparable: boolean;
    route_diverged: boolean;
    first_diverging_ttl: number | null;
  };
};

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isNumberOrNull(value: unknown): value is number | null {
  return (typeof value === "number" && Number.isFinite(value)) || value === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAsnInfo(value: unknown): value is TracerouteAsnInfo {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value["asn"]) || !Number.isInteger(value["asn"]) || value["asn"] < 0)
    return false;
  if (typeof value["prefix"] !== "string") return false;
  if (typeof value["country_code"] !== "string") return false;
  if (typeof value["registry"] !== "string") return false;
  if (typeof value["name"] !== "string") return false;
  return true;
}

function parseOptionalAsnInfo(raw: unknown): TracerouteAsnInfo | null | undefined {
  if (raw === undefined || raw === null) return null;
  return isAsnInfo(raw) ? raw : undefined;
}

function parseHops(value: unknown): TracerouteExtraV1["hops"] | null {
  if (!Array.isArray(value)) return null;

  const hops: TracerouteExtraV1["hops"] = [];
  let prevTtl = 0;

  for (const item of value) {
    if (!isRecord(item)) return null;
    if (!isFiniteNumber(item["ttl"])) return null;
    if (!Number.isInteger(item["ttl"]) || item["ttl"] <= 0) return null;
    if (item["ttl"] <= prevTtl) return null;
    prevTtl = item["ttl"];

    if (!Array.isArray(item["responses"])) return null;
    if (!isFiniteNumber(item["timeouts"])) return null;
    if (!Number.isInteger(item["timeouts"]) || item["timeouts"] < 0) return null;

    const responses: TracerouteExtraV1["hops"][number]["responses"] = [];
    for (const resp of item["responses"]) {
      if (!isRecord(resp)) return null;
      if (typeof resp["ip"] !== "string" && resp["ip"] !== null) return null;
      if (!isStringOrNull(resp["hostname"])) return null;
      const asnInfo = parseOptionalAsnInfo(resp["asn_info"]);
      if (asnInfo === undefined) return null;
      if (!isNumberOrNull(resp["rtt_ms"])) return null;
      responses.push({
        ip: resp["ip"],
        hostname: resp["hostname"],
        asn_info: asnInfo,
        rtt_ms: resp["rtt_ms"],
      });
    }

    hops.push({
      ttl: item["ttl"],
      responses,
      timeouts: item["timeouts"],
    });
  }

  return hops;
}

export function parseTracerouteExtraV1(value: unknown): TracerouteExtraV1 | null {
  if (!isRecord(value)) return null;
  if (value["kind"] !== "traceroute") return null;
  if (value["v"] !== 1) return null;

  if (typeof value["target"] !== "string" && value["target"] !== null) return null;
  if (typeof value["target_ip"] !== "string" && value["target_ip"] !== null) return null;
  if (!isStringOrNull(value["origin_ip"])) return null;
  const destinationAsnInfo = parseOptionalAsnInfo(value["destination_asn_info"]);
  if (destinationAsnInfo === undefined) return null;
  if (typeof value["destination_reached"] !== "boolean") return null;

  if (!isFiniteNumber(value["total_duration_ms"])) return null;
  if (!isNumberOrNull(value["avg_rtt_ms"])) return null;
  if (typeof value["protocol_used"] !== "string") return null;
  if (typeof value["socket_mode_used"] !== "string") return null;

  if (!isFiniteNumber(value["start_ttl"])) return null;
  if (!isFiniteNumber(value["max_hops"])) return null;
  if (!isFiniteNumber(value["queries_per_hop"])) return null;

  const hops = parseHops(value["hops"]);
  if (hops === null) return null;

  return {
    kind: "traceroute",
    v: 1,
    target: value["target"],
    target_ip: value["target_ip"],
    origin_ip: value["origin_ip"],
    destination_asn_info: destinationAsnInfo,
    destination_reached: value["destination_reached"],
    total_duration_ms: value["total_duration_ms"],
    avg_rtt_ms: value["avg_rtt_ms"],
    protocol_used: value["protocol_used"],
    socket_mode_used: value["socket_mode_used"],
    start_ttl: value["start_ttl"],
    max_hops: value["max_hops"],
    queries_per_hop: value["queries_per_hop"],
    hops,
  };
}

function parseTraceEntry(value: unknown): TracerouteExtraV2["traces"][number] | null {
  if (!isRecord(value)) return null;
  if (!isNumberOrNull(value["packet_size_bytes"])) return null;
  if (typeof value["destination_reached"] !== "boolean") return null;
  if (!isNumberOrNull(value["avg_rtt_ms"])) return null;
  if (!isStringOrNull(value["error_code"])) return null;
  if (!isNumberOrNull(value["path_mtu_bytes"])) return null;

  const fragHopTtl = value["frag_hop_ttl"] === undefined ? null : value["frag_hop_ttl"];
  if (!isNumberOrNull(fragHopTtl)) return null;

  const hops = parseHops(value["hops"]);
  if (hops === null) return null;

  return {
    packet_size_bytes: value["packet_size_bytes"],
    destination_reached: value["destination_reached"],
    avg_rtt_ms: value["avg_rtt_ms"],
    error_code: value["error_code"],
    path_mtu_bytes: value["path_mtu_bytes"],
    frag_hop_ttl: fragHopTtl,
    hops,
  };
}

function parseComparison(value: unknown): TracerouteExtraV2["comparison"] | null {
  if (!isRecord(value)) return null;
  if (typeof value["comparable"] !== "boolean") return null;
  if (typeof value["route_diverged"] !== "boolean") return null;
  if (!isNumberOrNull(value["first_diverging_ttl"])) return null;

  return {
    comparable: value["comparable"],
    route_diverged: value["route_diverged"],
    first_diverging_ttl: value["first_diverging_ttl"],
  };
}

export function parseTracerouteExtraV2(value: unknown): TracerouteExtraV2 | null {
  if (!isRecord(value)) return null;
  if (value["kind"] !== "traceroute") return null;
  if (value["v"] !== 2) return null;

  if (typeof value["target"] !== "string" && value["target"] !== null) return null;
  if (typeof value["target_ip"] !== "string" && value["target_ip"] !== null) return null;
  if (!isStringOrNull(value["origin_ip"])) return null;
  const destinationAsnInfo = parseOptionalAsnInfo(value["destination_asn_info"]);
  if (destinationAsnInfo === undefined) return null;

  if (typeof value["protocol_used"] !== "string") return null;
  if (typeof value["socket_mode_used"] !== "string") return null;
  if (typeof value["probe_style"] !== "string") return null;

  if (!isFiniteNumber(value["port"])) return null;
  if (!isFiniteNumber(value["start_ttl"])) return null;
  if (!isFiniteNumber(value["max_hops"])) return null;
  if (!isFiniteNumber(value["queries_per_hop"])) return null;
  if (!isFiniteNumber(value["total_duration_ms"])) return null;

  if (!Array.isArray(value["traces"])) return null;
  const traces: TracerouteExtraV2["traces"] = [];
  for (const item of value["traces"]) {
    const trace = parseTraceEntry(item);
    if (trace === null) return null;
    traces.push(trace);
  }

  const comparison = parseComparison(value["comparison"]);
  if (comparison === null) return null;

  return {
    kind: "traceroute",
    v: 2,
    target: value["target"],
    target_ip: value["target_ip"],
    origin_ip: value["origin_ip"],
    destination_asn_info: destinationAsnInfo,
    protocol_used: value["protocol_used"],
    socket_mode_used: value["socket_mode_used"],
    probe_style: value["probe_style"],
    port: value["port"],
    start_ttl: value["start_ttl"],
    max_hops: value["max_hops"],
    queries_per_hop: value["queries_per_hop"],
    total_duration_ms: value["total_duration_ms"],
    traces,
    comparison,
  };
}

export type TracerouteHop = TracerouteExtraV1["hops"][number];

export type TracerouteView = {
  protocol: "icmp" | "tcp";
  port: number | null;
  probeStyle: string | null;
  target: string | null;
  targetIp: string | null;
  originIp: string | null;
  traces: Array<{
    packetSizeBytes: number | null;
    destinationReached: boolean;
    errorCode: string | null;
    pathMtuBytes: number | null;
    fragHopTtl: number | null;
    hops: TracerouteHop[];
  }>;
  comparison: {
    comparable: boolean;
    routeDiverged: boolean;
    firstDivergingTtl: number | null;
  } | null;
};

function normalizeTracerouteProtocol(value: string): "icmp" | "tcp" {
  return value === "tcp" ? "tcp" : "icmp";
}

export function toTracerouteView(extra: TracerouteExtraV1 | TracerouteExtraV2): TracerouteView {
  if (extra.v === 2) {
    return {
      protocol: normalizeTracerouteProtocol(extra.protocol_used),
      port: extra.port,
      probeStyle: extra.probe_style,
      target: extra.target,
      targetIp: extra.target_ip,
      originIp: extra.origin_ip,
      traces: extra.traces.map((trace) => ({
        packetSizeBytes: trace.packet_size_bytes,
        destinationReached: trace.destination_reached,
        errorCode: trace.error_code,
        pathMtuBytes: trace.path_mtu_bytes,
        fragHopTtl: trace.frag_hop_ttl,
        hops: trace.hops,
      })),
      comparison: {
        comparable: extra.comparison.comparable,
        routeDiverged: extra.comparison.route_diverged,
        firstDivergingTtl: extra.comparison.first_diverging_ttl,
      },
    };
  }

  return {
    protocol: normalizeTracerouteProtocol(extra.protocol_used),
    port: null,
    probeStyle: null,
    target: extra.target,
    targetIp: extra.target_ip,
    originIp: extra.origin_ip,
    traces: [
      {
        packetSizeBytes: null,
        destinationReached: extra.destination_reached,
        errorCode: null,
        pathMtuBytes: null,
        fragHopTtl: null,
        hops: extra.hops,
      },
    ],
    comparison: null,
  };
}

/** Tries v2 first, then falls back to v1. Returns null if neither parses. */
export function parseTracerouteView(value: unknown): TracerouteView | null {
  const v2 = parseTracerouteExtraV2(value);
  if (v2) return toTracerouteView(v2);
  const v1 = parseTracerouteExtraV1(value);
  if (v1) return toTracerouteView(v1);
  return null;
}
