import { isIP } from "node:net";
import { normalizeTransportIp, parseIpv4Bytes, parseIpv6ToHextets, stripOptionalPort } from "./ip";

type Cidr4 = { family: 4; network: number; mask: number };
type Cidr6 = { family: 6; network: bigint; mask: bigint };
export type Cidr = Cidr4 | Cidr6;

const LOOPBACK_SPECS = ["127.0.0.0/8", "::1/128"] as const;

const NAMED_GROUP_SPECS: Record<string, readonly string[]> = {
  private: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"],
  linklocal: ["169.254.0.0/16", "fe80::/10"],
  cgnat: ["100.64.0.0/10"],
};

function ipv4ToUint32(bytes: readonly [number, number, number, number]): number {
  return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
}

function ipv6ToBigInt(hextets: readonly number[]): bigint {
  let n = 0n;
  for (let i = 0; i < 8; i += 1) {
    n = (n << 16n) | BigInt(hextets[i] ?? 0);
  }
  return n;
}

function maskForPrefix4(prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

function maskForPrefix6(prefix: number): bigint {
  if (prefix <= 0) return 0n;
  if (prefix >= 128) return (1n << 128n) - 1n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
}

function parseCidr(spec: string): Cidr | null {
  const slash = spec.indexOf("/");
  if (slash < 0) return null;
  const addr = spec.slice(0, slash);
  const prefix = Number(spec.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0) return null;

  const family = isIP(addr);
  if (family === 4) {
    if (prefix > 32) return null;
    const bytes = parseIpv4Bytes(addr);
    if (!bytes) return null;
    return { family: 4, network: ipv4ToUint32(bytes), mask: maskForPrefix4(prefix) };
  }
  if (family === 6) {
    if (prefix > 128) return null;
    const hextets = parseIpv6ToHextets(addr);
    if (!hextets) return null;
    return { family: 6, network: ipv6ToBigInt(hextets), mask: maskForPrefix6(prefix) };
  }
  return null;
}

function matchCidr(ip: string, cidr: Cidr): boolean {
  const family = isIP(ip);
  if (family === 4 && cidr.family === 4) {
    const bytes = parseIpv4Bytes(ip);
    if (!bytes) return false;
    return (ipv4ToUint32(bytes) & cidr.mask) === (cidr.network & cidr.mask);
  }
  if (family === 6 && cidr.family === 6) {
    const hextets = parseIpv6ToHextets(ip);
    if (!hextets) return false;
    return (ipv6ToBigInt(hextets) & cidr.mask) === (cidr.network & cidr.mask);
  }
  return false;
}

function parseBuiltinCidrs(specs: readonly string[]): Cidr[] {
  return specs.map((spec) => {
    const cidr = parseCidr(spec);
    if (!cidr) throw new Error(`invalid built-in CIDR: ${spec}`);
    return cidr;
  });
}

const LOOPBACK_CIDRS: readonly Cidr[] = parseBuiltinCidrs(LOOPBACK_SPECS);

let trustedProxies: readonly Cidr[] = LOOPBACK_CIDRS;

export function parseTrustedProxyExtras(raw: string | undefined | null): Cidr[] {
  if (!raw) return [];
  const out: Cidr[] = [];
  for (const rawToken of raw.split(",")) {
    const token = rawToken.trim();
    if (!token) continue;
    const group = NAMED_GROUP_SPECS[token.toLowerCase()];
    if (group) {
      out.push(...parseBuiltinCidrs(group));
      continue;
    }
    const cidr = parseCidr(token);
    if (!cidr) throw new Error(`invalid HINA_TRUSTED_PROXIES entry: ${token}`);
    out.push(cidr);
  }
  return out;
}

export function configureTrustedProxies(extras: readonly Cidr[]): void {
  trustedProxies = extras.length === 0 ? LOOPBACK_CIDRS : [...LOOPBACK_CIDRS, ...extras];
}

function isTrustedIp(ip: string): boolean {
  for (const cidr of trustedProxies) {
    if (matchCidr(ip, cidr)) return true;
  }
  return false;
}

function normalizePeer(peerIp: string | null | undefined): string | null {
  return normalizeTransportIp(peerIp ?? null);
}

function parseForwardedToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return normalizeTransportIp(stripOptionalPort(trimmed));
}

function parseXForwardedForTokens(header: string | null): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const raw of header.split(",")) {
    const parsed = parseForwardedToken(raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function isTrustedPeer(peerIp: string | null | undefined): boolean {
  const normalized = normalizePeer(peerIp);
  if (!normalized) return false;
  return isTrustedIp(normalized);
}

export function resolveClientIp(
  req: Request,
  peerIp: string | null | undefined,
): string | undefined {
  const normalizedPeer = normalizePeer(peerIp);
  if (!normalizedPeer) return undefined;
  if (!isTrustedIp(normalizedPeer)) return normalizedPeer;

  const tokens = parseXForwardedForTokens(req.headers.get("x-forwarded-for"));
  if (tokens.length === 0) return normalizedPeer;

  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]!;
    if (!isTrustedIp(token)) return token;
  }
  return tokens[0];
}

export function resolveForwardedProto(
  req: Request,
  peerIp: string | null | undefined,
): "http" | "https" | null {
  if (!isTrustedPeer(peerIp)) return null;
  const raw = req.headers.get("x-forwarded-proto");
  if (!raw) return null;
  const first = raw.split(",")[0]?.trim().toLowerCase();
  if (first === "http" || first === "https") return first;
  return null;
}
