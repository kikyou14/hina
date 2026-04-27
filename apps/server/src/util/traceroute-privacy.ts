import { isRecord } from "./lang";

export const PUBLIC_TRACEROUTE_IP_MASK = "***.***.***.***";

type PublicTracerouteOptions = {
  revealHopDetails: boolean;
};

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6_RE = /(?<!\w)(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?!\w)/g;

const IP_FIELDS = new Set(["target", "target_ip", "origin_ip", "ip"]);
const ASN_FIELDS = new Set(["asn_info", "destination_asn_info"]);

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  const c = Number(parts[2]);
  const d = Number(parts[3]);
  if ([a, b, c, d].some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return [a, b, c, d];
}

export function isPrivateIp(ip: string): boolean {
  const s = ip.trim().toLowerCase();

  // IPv6
  if (s === "::1") return true;
  if (s.startsWith("fc") || s.startsWith("fd")) return true;
  if (s.startsWith("fe80")) return true;

  // IPv4
  const octets = parseIpv4Octets(s);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 127) return true;
  return false;
}

function cloneObjectWithoutKeys(
  value: Record<string, unknown>,
  skipKeys: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (skipKeys.has(k)) continue;
    Object.defineProperty(out, k, {
      value: stripTracerouteAsnInfo(v),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

export function stripTracerouteAsnInfo(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => stripTracerouteAsnInfo(v));
  if (typeof value === "object" && value !== null) {
    return cloneObjectWithoutKeys(value as Record<string, unknown>, ASN_FIELDS);
  }
  return value;
}

function filterPrivateHops(hops: unknown[]): unknown[] {
  return hops.filter((hop) => {
    if (!isRecord(hop)) return true;
    const responses = hop.responses;
    if (!Array.isArray(responses) || responses.length === 0) return true;
    return !responses.every((resp) => {
      if (!isRecord(resp)) return false;
      return typeof resp.ip === "string" && isPrivateIp(resp.ip);
    });
  });
}

function stripDestinationHopDetails(hops: unknown[], destinationReached: unknown): unknown[] {
  if (destinationReached !== true || hops.length === 0) return hops;

  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (!isRecord(hop) || !Array.isArray(hop.responses) || hop.responses.length === 0) continue;

    const stripped = hop.responses.map((resp: unknown) => {
      if (!isRecord(resp)) return resp;
      return { ...resp, hostname: null, asn_info: null };
    });
    const result = [...hops];
    result[i] = { ...hop, responses: stripped };
    return result;
  }
  return hops;
}

function anonymizeTracerouteObjectForPublic(
  value: Record<string, unknown>,
  options: PublicTracerouteOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "destination_asn_info") continue;
    if (!options.revealHopDetails && k === "asn_info") continue;

    let nextValue: unknown;
    if (IP_FIELDS.has(k)) {
      nextValue = null;
    } else if (!options.revealHopDetails && k === "hostname") {
      nextValue = null;
    } else {
      nextValue = anonymizeTracerouteValue(v, options);
    }

    Object.defineProperty(out, k, {
      value: nextValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return out;
}

function anonymizeTracerouteValue(value: unknown, options: PublicTracerouteOptions): unknown {
  if (Array.isArray(value)) return value.map((v) => anonymizeTracerouteValue(v, options));
  if (typeof value === "object" && value !== null) {
    return anonymizeTracerouteObjectForPublic(value as Record<string, unknown>, options);
  }
  return value;
}

export function anonymizeTracerouteExtraForPublic(
  value: unknown,
  options: PublicTracerouteOptions,
): unknown {
  if (isRecord(value) && Array.isArray(value.hops)) {
    let hops = filterPrivateHops(value.hops);
    hops = stripDestinationHopDetails(hops, value.destination_reached);
    value = { ...value, hops };
  }
  return anonymizeTracerouteValue(value, options);
}

export function sanitizeTracerouteExtraRawJsonForPublic(
  input: string,
  options: PublicTracerouteOptions,
): string {
  const nulledIps = input.replace(
    /"(target|target_ip|origin_ip|ip)"\s*:\s*(null|"[^",}\]]*"?)/g,
    (_match, key: string) => `"${key}":null`,
  );

  const maybeWithoutHostname = options.revealHopDetails
    ? nulledIps
    : nulledIps.replace(/"hostname"\s*:\s*(null|"[^",}\]]*"?)/g, '"hostname":null');

  const withoutDestAsn = maybeWithoutHostname.replace(
    /"destination_asn_info"\s*:\s*\{[^}]*\}/g,
    '"destination_asn_info":null',
  );
  const maybeWithoutAsn = options.revealHopDetails
    ? withoutDestAsn
    : withoutDestAsn.replace(/"asn_info"\s*:\s*\{[^}]*\}/g, '"asn_info":null');

  return maybeWithoutAsn
    .replace(IPV4_RE, PUBLIC_TRACEROUTE_IP_MASK)
    .replace(IPV6_RE, PUBLIC_TRACEROUTE_IP_MASK);
}
