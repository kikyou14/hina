import { describe, expect, test } from "bun:test";

import { isPublicIp, resolveAgentIpFamilies, selectAgentGeoIp } from "./ip";

describe("resolveAgentIpFamilies", () => {
  test("prefers reported addresses when both families are present", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "157.254.18.138",
        reportedIpv6: "2a14:7586:1cfc::1",
        transportIp: "203.0.113.10",
      }),
    ).toEqual({
      ipv4: "157.254.18.138",
      ipv6: "2a14:7586:1cfc::1",
    });
  });

  test("fills missing IPv6 from transport when IPv4 is reported", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "157.254.18.138",
        reportedIpv6: null,
        transportIp: "2a14:7586:1cfc::1",
      }),
    ).toEqual({
      ipv4: "157.254.18.138",
      ipv6: "2a14:7586:1cfc::1",
    });
  });

  test("fills missing IPv4 from transport when IPv6 is reported", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: null,
        reportedIpv6: "2a14:7586:1cfc::1",
        transportIp: "157.254.18.138",
      }),
    ).toEqual({
      ipv4: "157.254.18.138",
      ipv6: "2a14:7586:1cfc::1",
    });
  });

  test("falls back to transport IPv4 when reported addresses are missing", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: null,
        reportedIpv6: null,
        transportIp: "203.0.113.10",
      }),
    ).toEqual({
      ipv4: "203.0.113.10",
      ipv6: null,
    });
  });

  test("falls back to transport IPv6 when reported addresses are missing", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: null,
        reportedIpv6: null,
        transportIp: "2001:db8::10",
      }),
    ).toEqual({
      ipv4: null,
      ipv6: "2001:db8::10",
    });
  });

  test("treats IPv4-mapped IPv6 transport as IPv4", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: null,
        reportedIpv6: null,
        transportIp: "::ffff:203.0.113.10",
      }),
    ).toEqual({
      ipv4: "203.0.113.10",
      ipv6: null,
    });
  });

  test("treats IPv4-mapped IPv6 transport (hex form) as IPv4", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: null,
        reportedIpv6: null,
        transportIp: "::ffff:cb00:710a",
      }),
    ).toEqual({
      ipv4: "203.0.113.10",
      ipv6: null,
    });
  });

  test("trims whitespace and treats blank strings as missing", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "  203.0.113.10  ",
        reportedIpv6: " \n",
        transportIp: "\t",
      }),
    ).toEqual({
      ipv4: "203.0.113.10",
      ipv6: null,
    });
  });

  test("ignores invalid transport IPs", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: null,
        reportedIpv6: null,
        transportIp: "not-an-ip",
      }),
    ).toEqual({
      ipv4: null,
      ipv6: null,
    });
  });

  test("uses transport fallback only for matching family", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "not-an-ip",
        reportedIpv6: "2a14:7586:1cfc::1",
        transportIp: "203.0.113.10",
      }),
    ).toEqual({
      ipv4: "203.0.113.10",
      ipv6: "2a14:7586:1cfc::1",
    });
  });

  test("rejects invalid family assignments", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "2001:db8::10",
        reportedIpv6: "203.0.113.10",
        transportIp: "198.51.100.7",
      }),
    ).toEqual({
      ipv4: "198.51.100.7",
      ipv6: null,
    });
  });
});

describe("isPublicIp", () => {
  test("returns true for globally routable IPv4", () => {
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("157.254.18.138")).toBe(true);
    expect(isPublicIp("1.1.1.1")).toBe(true);
  });

  test("rejects RFC 1918 private ranges", () => {
    expect(isPublicIp("10.0.0.1")).toBe(false);
    expect(isPublicIp("10.255.255.255")).toBe(false);
    expect(isPublicIp("172.16.0.1")).toBe(false);
    expect(isPublicIp("172.31.255.255")).toBe(false);
    expect(isPublicIp("192.168.0.1")).toBe(false);
    expect(isPublicIp("192.168.255.255")).toBe(false);
  });

  test("rejects CGNAT / Tailscale range (100.64.0.0/10)", () => {
    expect(isPublicIp("100.64.0.1")).toBe(false);
    expect(isPublicIp("100.100.100.100")).toBe(false);
    expect(isPublicIp("100.127.255.255")).toBe(false);
  });

  test("rejects loopback, link-local, and special-use IPv4", () => {
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("169.254.1.1")).toBe(false);
    expect(isPublicIp("0.0.0.0")).toBe(false);
    expect(isPublicIp("192.0.0.1")).toBe(false); // IETF Protocol Assignments
    expect(isPublicIp("192.0.0.8")).toBe(false); // IPv4 dummy
    expect(isPublicIp("192.0.0.11")).toBe(false); // still inside 192.0.0.0/24
    expect(isPublicIp("192.0.2.1")).toBe(false);
    expect(isPublicIp("198.18.0.1")).toBe(false); // benchmarking
    expect(isPublicIp("198.19.255.254")).toBe(false);
    expect(isPublicIp("198.51.100.1")).toBe(false);
    expect(isPublicIp("203.0.113.1")).toBe(false);
    expect(isPublicIp("224.0.0.1")).toBe(false);
    expect(isPublicIp("255.255.255.255")).toBe(false);
  });

  test("allows the globally-reachable anycast addresses in 192.0.0.0/24", () => {
    // RFC 7723: 192.0.0.9 Port Control Protocol Anycast
    expect(isPublicIp("192.0.0.9")).toBe(true);
    // RFC 8155: 192.0.0.10 Traversal Using Relays around NAT Anycast
    expect(isPublicIp("192.0.0.10")).toBe(true);
  });

  test("returns true for globally routable IPv6", () => {
    expect(isPublicIp("2a14:7586:1cfc::1")).toBe(true);
    expect(isPublicIp("2001:4860:4860::8888")).toBe(true);
  });

  test("rejects loopback, ULA, link-local, and multicast IPv6", () => {
    expect(isPublicIp("::1")).toBe(false);
    expect(isPublicIp("::")).toBe(false);
    expect(isPublicIp("fd12:3456:789a::1")).toBe(false);
    expect(isPublicIp("fc00::1")).toBe(false);
    expect(isPublicIp("fe80::1")).toBe(false);
    expect(isPublicIp("ff02::1")).toBe(false);
    expect(isPublicIp("ff05::2")).toBe(false);
  });

  test("rejects IPv6 documentation prefix 2001:db8::/32", () => {
    expect(isPublicIp("2001:db8::1")).toBe(false);
    expect(isPublicIp("2001:0db8:85a3::8a2e:0370:7334")).toBe(false);
    expect(isPublicIp("2001:db8:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(false);
    // 2001:db9:: is outside the /32 block -> public
    expect(isPublicIp("2001:db9::1")).toBe(true);
  });

  test("handles IPv4-mapped IPv6 addresses", () => {
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicIp("::ffff:157.254.18.138")).toBe(true);
    expect(isPublicIp("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicIp("::ffff:192.168.1.1")).toBe(false);
    expect(isPublicIp("::ffff:172.16.0.1")).toBe(false);
    expect(isPublicIp("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIp("::ffff:100.100.100.100")).toBe(false);
  });

  test("handles IPv4-mapped IPv6 in hex form", () => {
    expect(isPublicIp("::ffff:0808:0808")).toBe(true);
    expect(isPublicIp("::ffff:0a00:0001")).toBe(false);
    expect(isPublicIp("::ffff:c0a8:0101")).toBe(false);
  });

  test("rejects invalid input", () => {
    expect(isPublicIp("not-an-ip")).toBe(false);
    expect(isPublicIp("")).toBe(false);
  });
});

describe("selectAgentGeoIp", () => {
  test("prefers reported public IPv4 over public transport IP", () => {
    expect(
      selectAgentGeoIp({
        reportedIpv4: "8.8.8.8",
        reportedIpv6: "2001:4860:4860::8888",
        transportIp: "104.16.0.1",
      }),
    ).toBe("8.8.8.8");
  });

  test("falls back to reported public IPv6 before transport IP", () => {
    expect(
      selectAgentGeoIp({
        reportedIpv4: "10.0.0.2",
        reportedIpv6: "2001:4860:4860::8888",
        transportIp: "104.16.0.1",
      }),
    ).toBe("2001:4860:4860::8888");
  });

  test("uses public transport IP only when reported addresses are not public", () => {
    expect(
      selectAgentGeoIp({
        reportedIpv4: "10.0.0.2",
        reportedIpv6: "fd12:3456:789a::1",
        transportIp: "104.16.0.1",
      }),
    ).toBe("104.16.0.1");
  });

  test("rejects invalid reported addresses before falling back", () => {
    expect(
      selectAgentGeoIp({
        reportedIpv4: "not-an-ip",
        reportedIpv6: "203.0.113.10",
        transportIp: "104.16.0.1",
      }),
    ).toBe("104.16.0.1");
  });
});
