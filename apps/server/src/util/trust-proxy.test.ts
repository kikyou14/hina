import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  configureTrustedProxies,
  isTrustedPeer,
  parseTrustedProxyExtras,
  resolveClientIp,
  resolveForwardedProto,
} from "./trust-proxy";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://hina.test/", { headers });
}

// Reset to the default loopback-only set before each test so state from
// `configureTrustedProxies` does not bleed between cases.
beforeEach(() => configureTrustedProxies([]));
afterEach(() => configureTrustedProxies([]));

describe("isTrustedPeer (default loopback-only)", () => {
  test("trusts loopback IPv4 and IPv6", () => {
    expect(isTrustedPeer("127.0.0.1")).toBe(true);
    expect(isTrustedPeer("127.255.255.254")).toBe(true);
    expect(isTrustedPeer("::1")).toBe(true);
  });

  test("does NOT trust RFC 1918 ranges by default", () => {
    expect(isTrustedPeer("10.0.0.1")).toBe(false);
    expect(isTrustedPeer("172.16.0.1")).toBe(false);
    expect(isTrustedPeer("192.168.1.1")).toBe(false);
  });

  test("does NOT trust ULA / link-local / CGNAT by default", () => {
    expect(isTrustedPeer("fc00::1")).toBe(false);
    expect(isTrustedPeer("fd12:3456:789a::1")).toBe(false);
    expect(isTrustedPeer("fe80::1")).toBe(false);
    expect(isTrustedPeer("169.254.1.1")).toBe(false);
    expect(isTrustedPeer("100.64.0.1")).toBe(false);
  });

  test("does NOT trust public IPs", () => {
    expect(isTrustedPeer("8.8.8.8")).toBe(false);
    expect(isTrustedPeer("203.0.113.1")).toBe(false);
    expect(isTrustedPeer("2a14:7586:1cfc::1")).toBe(false);
  });

  test("normalizes IPv4-mapped IPv6 before checking", () => {
    expect(isTrustedPeer("::ffff:127.0.0.1")).toBe(true);
    expect(isTrustedPeer("::ffff:10.0.0.1")).toBe(false);
  });

  test("returns false for undefined, null, empty, and malformed input", () => {
    expect(isTrustedPeer(undefined)).toBe(false);
    expect(isTrustedPeer(null)).toBe(false);
    expect(isTrustedPeer("")).toBe(false);
    expect(isTrustedPeer("not-an-ip")).toBe(false);
  });
});

describe("parseTrustedProxyExtras", () => {
  test("returns [] for empty / unset input", () => {
    expect(parseTrustedProxyExtras(undefined)).toEqual([]);
    expect(parseTrustedProxyExtras(null)).toEqual([]);
    expect(parseTrustedProxyExtras("")).toEqual([]);
    expect(parseTrustedProxyExtras("  ")).toEqual([]);
    expect(parseTrustedProxyExtras(" , ,")).toEqual([]);
  });

  test("parses raw CIDR entries", () => {
    expect(parseTrustedProxyExtras("10.0.0.0/8")).toHaveLength(1);
    expect(parseTrustedProxyExtras("10.0.0.0/8, fc00::/7")).toHaveLength(2);
  });

  test("expands named groups case-insensitively", () => {
    // private: 4 entries (10/8, 172.16/12, 192.168/16, fc00::/7)
    expect(parseTrustedProxyExtras("private")).toHaveLength(4);
    expect(parseTrustedProxyExtras("Private")).toHaveLength(4);
    expect(parseTrustedProxyExtras("PRIVATE")).toHaveLength(4);
    // linklocal: 2 entries
    expect(parseTrustedProxyExtras("linklocal")).toHaveLength(2);
    // cgnat: 1 entry
    expect(parseTrustedProxyExtras("cgnat")).toHaveLength(1);
  });

  test("mixes named groups and raw CIDRs", () => {
    // private (4) + 1 extra CIDR = 5
    expect(parseTrustedProxyExtras("private, 10.10.0.0/16")).toHaveLength(5);
  });

  test("throws on malformed entries so bad config fails at boot", () => {
    expect(() => parseTrustedProxyExtras("not-an-ip")).toThrow(/HINA_TRUSTED_PROXIES/);
    expect(() => parseTrustedProxyExtras("10.0.0.1")).toThrow(/HINA_TRUSTED_PROXIES/);
    expect(() => parseTrustedProxyExtras("10.0.0.0/33")).toThrow(/HINA_TRUSTED_PROXIES/);
    expect(() => parseTrustedProxyExtras("::/129")).toThrow(/HINA_TRUSTED_PROXIES/);
    expect(() => parseTrustedProxyExtras("private, junk")).toThrow(/HINA_TRUSTED_PROXIES/);
  });
});

describe("configureTrustedProxies", () => {
  test("loopback stays trusted even when extras replace nothing", () => {
    configureTrustedProxies(parseTrustedProxyExtras("10.0.0.0/8"));
    expect(isTrustedPeer("127.0.0.1")).toBe(true);
    expect(isTrustedPeer("::1")).toBe(true);
    expect(isTrustedPeer("10.0.0.5")).toBe(true);
  });

  test("extras are scoped to the configured range only", () => {
    configureTrustedProxies(parseTrustedProxyExtras("10.0.0.0/8"));
    expect(isTrustedPeer("10.0.0.5")).toBe(true);
    expect(isTrustedPeer("192.168.1.1")).toBe(false);
    expect(isTrustedPeer("fc00::1")).toBe(false);
  });

  test("named 'private' group trusts RFC 1918 + ULA", () => {
    configureTrustedProxies(parseTrustedProxyExtras("private"));
    expect(isTrustedPeer("10.0.0.1")).toBe(true);
    expect(isTrustedPeer("172.16.0.1")).toBe(true);
    expect(isTrustedPeer("172.31.255.255")).toBe(true);
    expect(isTrustedPeer("172.32.0.1")).toBe(false);
    expect(isTrustedPeer("192.168.1.1")).toBe(true);
    expect(isTrustedPeer("fc00::1")).toBe(true);
    expect(isTrustedPeer("fd12:3456:789a::1")).toBe(true);
    // link-local and CGNAT are NOT part of 'private'
    expect(isTrustedPeer("fe80::1")).toBe(false);
    expect(isTrustedPeer("169.254.1.1")).toBe(false);
    expect(isTrustedPeer("100.64.0.1")).toBe(false);
  });

  test("empty extras reset to loopback-only", () => {
    configureTrustedProxies(parseTrustedProxyExtras("private"));
    expect(isTrustedPeer("10.0.0.5")).toBe(true);
    configureTrustedProxies([]);
    expect(isTrustedPeer("10.0.0.5")).toBe(false);
    expect(isTrustedPeer("127.0.0.1")).toBe(true);
  });
});

describe("resolveClientIp", () => {
  test("returns the peer when peer is public, even with X-Forwarded-For", () => {
    // Critical regression guard: a caller bypassing the reverse proxy must
    // not be able to forge their IP via X-Forwarded-For.
    const req = makeRequest({ "x-forwarded-for": "1.2.3.4" });
    expect(resolveClientIp(req, "203.0.113.9")).toBe("203.0.113.9");
  });

  test("private peer is untrusted by default: X-Forwarded-For is ignored", () => {
    // Without HINA_TRUSTED_PROXIES, a Docker-sibling host cannot spoof the
    // client IP via X-Forwarded-For; we return the peer unchanged.
    const req = makeRequest({ "x-forwarded-for": "1.2.3.4" });
    expect(resolveClientIp(req, "10.0.0.5")).toBe("10.0.0.5");
  });

  test("returns undefined when peer is unknown, even with X-Forwarded-For", () => {
    const req = makeRequest({ "x-forwarded-for": "1.2.3.4" });
    expect(resolveClientIp(req, undefined)).toBeUndefined();
    expect(resolveClientIp(req, null)).toBeUndefined();
    expect(resolveClientIp(req, "")).toBeUndefined();
  });

  test("returns peer when peer is loopback but no X-Forwarded-For is present", () => {
    const req = makeRequest();
    expect(resolveClientIp(req, "127.0.0.1")).toBe("127.0.0.1");
  });

  test("reads X-Forwarded-For when peer is loopback", () => {
    const req = makeRequest({ "x-forwarded-for": "203.0.113.9" });
    expect(resolveClientIp(req, "127.0.0.1")).toBe("203.0.113.9");
  });

  test("walks X-Forwarded-For right-to-left, skipping trusted hops", () => {
    // Configure an internal LB range as trusted in addition to loopback.
    // XFF: client, cdn(public), internal-lb(trusted) — rightmost-untrusted is cdn.
    configureTrustedProxies(parseTrustedProxyExtras("10.0.0.0/8"));
    const req = makeRequest({ "x-forwarded-for": "203.0.113.9, 198.51.100.7, 10.0.0.1" });
    expect(resolveClientIp(req, "127.0.0.1")).toBe("198.51.100.7");
  });

  test("skips a spoofed public entry on the left when trusted hops trail it", () => {
    // Attacker injects 1.2.3.4 as the first token, but our two trusted
    // proxies still appended themselves; the walk stops at the real client
    // (the last untrusted entry from the right).
    configureTrustedProxies(parseTrustedProxyExtras("10.0.0.0/8"));
    const req = makeRequest({ "x-forwarded-for": "1.2.3.4, 10.0.0.1, 10.0.0.2" });
    expect(resolveClientIp(req, "127.0.0.1")).toBe("1.2.3.4");
  });

  test("falls back to leftmost when every hop is trusted", () => {
    configureTrustedProxies(parseTrustedProxyExtras("10.0.0.0/8"));
    const req = makeRequest({ "x-forwarded-for": "10.0.0.5, 10.0.0.1" });
    expect(resolveClientIp(req, "127.0.0.1")).toBe("10.0.0.5");
  });

  test("ignores invalid tokens in X-Forwarded-For", () => {
    const req = makeRequest({ "x-forwarded-for": "not-an-ip, 203.0.113.9" });
    expect(resolveClientIp(req, "127.0.0.1")).toBe("203.0.113.9");
  });

  test("strips optional ports in X-Forwarded-For tokens", () => {
    const req = makeRequest({ "x-forwarded-for": "203.0.113.9:443" });
    expect(resolveClientIp(req, "127.0.0.1")).toBe("203.0.113.9");
  });

  test("strips bracketed IPv6 port suffix", () => {
    const req = makeRequest({ "x-forwarded-for": "[2001:db8::1]:443" });
    expect(resolveClientIp(req, "::1")).toBe("2001:db8::1");
  });

  test("normalizes IPv4-mapped IPv6 tokens to IPv4", () => {
    const req = makeRequest({ "x-forwarded-for": "::ffff:203.0.113.9" });
    expect(resolveClientIp(req, "127.0.0.1")).toBe("203.0.113.9");
  });

  test("normalizes a peer given as IPv4-mapped IPv6", () => {
    const req = makeRequest({ "x-forwarded-for": "203.0.113.9" });
    expect(resolveClientIp(req, "::ffff:127.0.0.1")).toBe("203.0.113.9");
  });

  test("returns peer when X-Forwarded-For contains only invalid tokens", () => {
    const req = makeRequest({ "x-forwarded-for": "not-an-ip, , " });
    expect(resolveClientIp(req, "127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("resolveForwardedProto", () => {
  test("returns null when peer is untrusted (public)", () => {
    const req = makeRequest({ "x-forwarded-proto": "https" });
    expect(resolveForwardedProto(req, "203.0.113.1")).toBeNull();
  });

  test("returns null when peer is a private IP but default config does not trust it", () => {
    const req = makeRequest({ "x-forwarded-proto": "https" });
    expect(resolveForwardedProto(req, "10.0.0.5")).toBeNull();
  });

  test("returns null when peer is undefined", () => {
    const req = makeRequest({ "x-forwarded-proto": "https" });
    expect(resolveForwardedProto(req, undefined)).toBeNull();
  });

  test("returns the first value when peer is loopback", () => {
    const req = makeRequest({ "x-forwarded-proto": "https" });
    expect(resolveForwardedProto(req, "127.0.0.1")).toBe("https");
  });

  test("only considers the first comma-separated value", () => {
    const req = makeRequest({ "x-forwarded-proto": "https, http" });
    expect(resolveForwardedProto(req, "127.0.0.1")).toBe("https");
  });

  test("returns null for unknown protocols", () => {
    const req = makeRequest({ "x-forwarded-proto": "ftp" });
    expect(resolveForwardedProto(req, "127.0.0.1")).toBeNull();
  });

  test("returns null when the header is absent", () => {
    const req = makeRequest();
    expect(resolveForwardedProto(req, "127.0.0.1")).toBeNull();
  });

  test("is case-insensitive", () => {
    const req = makeRequest({ "x-forwarded-proto": "HTTPS" });
    expect(resolveForwardedProto(req, "127.0.0.1")).toBe("https");
  });

  test("respects configured extras", () => {
    configureTrustedProxies(parseTrustedProxyExtras("10.0.0.0/8"));
    const req = makeRequest({ "x-forwarded-proto": "https" });
    expect(resolveForwardedProto(req, "10.0.0.5")).toBe("https");
  });
});
