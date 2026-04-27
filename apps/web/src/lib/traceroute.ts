import { isRecord } from "@/lib/typeGuards";

export type TracerouteExtraV1 = {
  kind: "traceroute";
  v: 1;
  target: string | null;
  target_ip: string | null;
  origin_ip: string | null;
  destination_asn_info: {
    asn: number;
    prefix: string;
    country_code: string;
    registry: string;
    name: string;
  } | null;
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
      asn_info: {
        asn: number;
        prefix: string;
        country_code: string;
        registry: string;
        name: string;
      } | null;
      rtt_ms: number | null;
    }>;
    timeouts: number;
  }>;
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

function isAsnInfo(
  value: unknown,
): value is NonNullable<TracerouteExtraV1["destination_asn_info"]> {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value["asn"]) || !Number.isInteger(value["asn"]) || value["asn"] < 0)
    return false;
  if (typeof value["prefix"] !== "string") return false;
  if (typeof value["country_code"] !== "string") return false;
  if (typeof value["registry"] !== "string") return false;
  if (typeof value["name"] !== "string") return false;
  return true;
}

export function parseTracerouteExtraV1(value: unknown): TracerouteExtraV1 | null {
  if (!isRecord(value)) return null;
  if (value["kind"] !== "traceroute") return null;
  if (value["v"] !== 1) return null;

  if (typeof value["target"] !== "string" && value["target"] !== null) return null;
  if (typeof value["target_ip"] !== "string" && value["target_ip"] !== null) return null;
  if (!isStringOrNull(value["origin_ip"])) return null;
  const destinationAsnRaw = value["destination_asn_info"];
  const destinationAsnInfo =
    destinationAsnRaw === undefined || destinationAsnRaw === null
      ? null
      : isAsnInfo(destinationAsnRaw)
        ? destinationAsnRaw
        : null;
  if (destinationAsnRaw !== undefined && destinationAsnRaw !== null && destinationAsnInfo === null)
    return null;
  if (typeof value["destination_reached"] !== "boolean") return null;

  if (!isFiniteNumber(value["total_duration_ms"])) return null;
  if (!isNumberOrNull(value["avg_rtt_ms"])) return null;
  if (typeof value["protocol_used"] !== "string") return null;
  if (typeof value["socket_mode_used"] !== "string") return null;

  if (!isFiniteNumber(value["start_ttl"])) return null;
  if (!isFiniteNumber(value["max_hops"])) return null;
  if (!isFiniteNumber(value["queries_per_hop"])) return null;

  if (!Array.isArray(value["hops"])) return null;

  const hops: TracerouteExtraV1["hops"] = [];
  let prevTtl = 0;

  for (const item of value["hops"]) {
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
      const asnRaw = resp["asn_info"];
      const asnInfo =
        asnRaw === undefined || asnRaw === null ? null : isAsnInfo(asnRaw) ? asnRaw : null;
      if (asnRaw !== undefined && asnRaw !== null && asnInfo === null) return null;
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
