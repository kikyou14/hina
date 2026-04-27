import { isIP } from "node:net";

export type AgentIpFamilies = {
  ipv4: string | null;
  ipv6: string | null;
};

export type AgentGeoIpCandidates = {
  reportedIpv4?: string | null;
  reportedIpv6?: string | null;
  transportIp?: string | null;
};

export function parseIpv4Bytes(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums.length === 4 ? (nums as [number, number, number, number]) : null;
}

function parseHextet(value: string): number | null {
  if (!value) return null;
  if (!/^[0-9a-fA-F]{1,4}$/.test(value)) return null;
  const n = Number.parseInt(value, 16);
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
  return n;
}

export function parseIpv6ToHextets(
  value: string,
): [number, number, number, number, number, number, number, number] | null {
  const input = value.trim();
  if (!input) return null;
  if (input.includes("%")) return null;

  let head = input;
  let ipv4Tail: [number, number] | null = null;

  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    if (lastColon === -1) return null;

    const bytes = parseIpv4Bytes(input.slice(lastColon + 1));
    if (!bytes) return null;
    ipv4Tail = [((bytes[0] << 8) | bytes[1]) >>> 0, ((bytes[2] << 8) | bytes[3]) >>> 0] as [
      number,
      number,
    ];
    head = input.slice(0, lastColon);
  }

  const parts = head.split("::");
  if (parts.length > 2) return null;

  const leftParts = parts[0] ? parts[0].split(":").filter(Boolean) : [];
  const rightParts = parts.length === 2 && parts[1] ? parts[1].split(":").filter(Boolean) : [];

  const left: number[] = [];
  for (const part of leftParts) {
    const n = parseHextet(part);
    if (n === null) return null;
    left.push(n);
  }

  const right: number[] = [];
  for (const part of rightParts) {
    const n = parseHextet(part);
    if (n === null) return null;
    right.push(n);
  }

  const tail = ipv4Tail ? [ipv4Tail[0], ipv4Tail[1]] : [];
  const used = left.length + right.length + tail.length;

  if (parts.length === 1) {
    if (used !== 8) return null;
    const all = [...left, ...right, ...tail];
    return all.length === 8
      ? (all as [number, number, number, number, number, number, number, number])
      : null;
  }

  if (used > 8) return null;
  const zeros = new Array(8 - used).fill(0);
  const all = [...left, ...zeros, ...right, ...tail];
  return all.length === 8
    ? (all as [number, number, number, number, number, number, number, number])
    : null;
}

function extractIpv4FromIpv4MappedIpv6(value: string): string | null {
  const hextets = parseIpv6ToHextets(value);
  if (!hextets) return null;

  for (let i = 0; i < 5; i += 1) {
    if (hextets[i] !== 0) return null;
  }
  if (hextets[5] !== 0xffff) return null;

  const a = (hextets[6] >> 8) & 0xff;
  const b = hextets[6] & 0xff;
  const c = (hextets[7] >> 8) & 0xff;
  const d = hextets[7] & 0xff;
  return `${a}.${b}.${c}.${d}`;
}

function normalizeIpCandidate(value: string | null | undefined, family?: 4 | 6): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const resolvedFamily = isIP(trimmed);
  if (resolvedFamily === 0) return null;

  if (resolvedFamily === 6) {
    const mapped = extractIpv4FromIpv4MappedIpv6(trimmed);
    if (mapped) {
      if (family === 6) return null;
      return mapped;
    }
  }

  if (family !== undefined && resolvedFamily !== family) return null;
  return trimmed;
}

export function normalizeTransportIp(value: string | null | undefined): string | null {
  return normalizeIpCandidate(value);
}

export function stripOptionalPort(value: string): string {
  const bracketed = value.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1] ?? value;

  const ipv4WithPort = value.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
  if (ipv4WithPort) return ipv4WithPort[1] ?? value;

  return value;
}

/**
 * Returns true if the IP is globally routable (not RFC 1918 / RFC 6598 /
 * loopback / link-local / documentation / reserved / ULA / etc).
 */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const b = parseIpv4Bytes(ip);
    if (!b) return false;
    if (b[0] === 10) return false; // 10.0.0.0/8
    if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return false; // 172.16.0.0/12
    if (b[0] === 192 && b[1] === 168) return false; // 192.168.0.0/16
    if (b[0] === 100 && b[1] >= 64 && b[1] <= 127) return false; // 100.64.0.0/10 (CGNAT / Tailscale)
    if (b[0] === 127) return false; // 127.0.0.0/8
    if (b[0] === 169 && b[1] === 254) return false; // 169.254.0.0/16 link-local
    if (b[0] === 0) return false; // 0.0.0.0/8
    if (b[0] === 192 && b[1] === 0 && b[2] === 0 && b[3] !== 9 && b[3] !== 10) return false;
    if (b[0] === 192 && b[1] === 0 && b[2] === 2) return false; // 192.0.2.0/24 TEST-NET-1
    if (b[0] === 198 && (b[1] === 18 || b[1] === 19)) return false; // 198.18.0.0/15 benchmarking
    if (b[0] === 198 && b[1] === 51 && b[2] === 100) return false; // 198.51.100.0/24 TEST-NET-2
    if (b[0] === 203 && b[1] === 0 && b[2] === 113) return false; // 203.0.113.0/24 TEST-NET-3
    if (b[0] >= 224) return false; // multicast + reserved
    return true;
  }
  if (family === 6) {
    const mapped = extractIpv4FromIpv4MappedIpv6(ip);
    if (mapped) return isPublicIp(mapped);

    const h = parseIpv6ToHextets(ip);
    if (!h) return false;
    if (h.every((v) => v === 0)) return false; // ::
    if (
      h[0] === 0 &&
      h[1] === 0 &&
      h[2] === 0 &&
      h[3] === 0 &&
      h[4] === 0 &&
      h[5] === 0 &&
      h[6] === 0 &&
      h[7] === 1
    )
      return false; // ::1
    if ((h[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
    if ((h[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((h[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
    if (h[0] === 0x2001 && h[1] === 0x0db8) return false; // 2001:db8::/32 documentation
    return true;
  }
  return false;
}

export function resolveAgentIpFamilies(args: {
  reportedIpv4?: string | null;
  reportedIpv6?: string | null;
  transportIp?: string | null;
}): AgentIpFamilies {
  const ipv4 = normalizeIpCandidate(args.reportedIpv4, 4);
  const ipv6 = normalizeIpCandidate(args.reportedIpv6, 6);
  const transportIp = normalizeTransportIp(args.transportIp);
  const transportFamily = transportIp ? isIP(transportIp) : 0;

  return {
    ipv4: ipv4 ?? (transportFamily === 4 ? transportIp : null),
    ipv6: ipv6 ?? (transportFamily === 6 ? transportIp : null),
  };
}

export function selectAgentGeoIp(args: AgentGeoIpCandidates): string | null {
  const reportedIpv4 = normalizeIpCandidate(args.reportedIpv4, 4);
  if (reportedIpv4 && isPublicIp(reportedIpv4)) return reportedIpv4;

  const reportedIpv6 = normalizeIpCandidate(args.reportedIpv6, 6);
  if (reportedIpv6 && isPublicIp(reportedIpv6)) return reportedIpv6;

  const transportIp = normalizeTransportIp(args.transportIp);
  return transportIp && isPublicIp(transportIp) ? transportIp : null;
}
