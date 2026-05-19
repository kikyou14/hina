import { describe, expect, test } from "bun:test";

import {
  classifyIp,
  isPublicIp,
  isReportableIp,
  resolveAgentIpFamilies,
  selectAgentGeoIp,
} from "./ip";

describe("resolveAgentIpFamilies", () => {
  test("prefers reported addresses when both families are present", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "157.254.18.138",
        reportedIpv6: "2a14:7586:1cfc::1",
        transportIp: "8.8.8.8",
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
        transportIp: "8.8.8.8",
      }),
    ).toEqual({
      ipv4: "8.8.8.8",
      ipv6: null,
    });
  });

  test("falls back to transport IPv6 when reported addresses are missing", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: null,
        reportedIpv6: null,
        transportIp: "2a14:7586:1cfc::1",
      }),
    ).toEqual({
      ipv4: null,
      ipv6: "2a14:7586:1cfc::1",
    });
  });

  test("treats IPv4-mapped IPv6 transport as IPv4", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: null,
        reportedIpv6: null,
        transportIp: "::ffff:8.8.8.8",
      }),
    ).toEqual({
      ipv4: "8.8.8.8",
      ipv6: null,
    });
  });

  test("treats IPv4-mapped IPv6 transport (hex form) as IPv4", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: null,
        reportedIpv6: null,
        transportIp: "::ffff:0808:0808",
      }),
    ).toEqual({
      ipv4: "8.8.8.8",
      ipv6: null,
    });
  });

  test("trims whitespace and treats blank strings as missing", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "  8.8.8.8  ",
        reportedIpv6: " \n",
        transportIp: "\t",
      }),
    ).toEqual({
      ipv4: "8.8.8.8",
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
        transportIp: "8.8.8.8",
      }),
    ).toEqual({
      ipv4: "8.8.8.8",
      ipv6: "2a14:7586:1cfc::1",
    });
  });

  test("rejects invalid family assignments", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "2001:db8::10",
        reportedIpv6: "8.8.8.8",
        transportIp: "1.1.1.1",
      }),
    ).toEqual({
      ipv4: "1.1.1.1",
      ipv6: null,
    });
  });

  test("drops reported link-local IPv6 and falls back to transport when same family", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "8.8.8.8",
        reportedIpv6: "fe80::abcd",
        transportIp: "2a14:7586:1cfc::1",
      }),
    ).toEqual({
      ipv4: "8.8.8.8",
      ipv6: "2a14:7586:1cfc::1",
    });
  });

  test("drops reported link-local IPv6 when transport cannot fill the family", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "8.8.8.8",
        reportedIpv6: "fe80::abcd",
        transportIp: "1.1.1.1",
      }),
    ).toEqual({
      ipv4: "8.8.8.8",
      ipv6: null,
    });
  });

  test("drops reported link-local IPv4 (169.254/16)", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "169.254.1.1",
        reportedIpv6: null,
        transportIp: "8.8.8.8",
      }),
    ).toEqual({
      ipv4: "8.8.8.8",
      ipv6: null,
    });
  });

  test("drops loopback transport IP", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: null,
        reportedIpv6: null,
        transportIp: "127.0.0.1",
      }),
    ).toEqual({
      ipv4: null,
      ipv6: null,
    });
  });

  test("keeps RFC 1918 reported IPv4 (LAN-only deployment)", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "192.168.1.10",
        reportedIpv6: null,
        transportIp: null,
      }),
    ).toEqual({
      ipv4: "192.168.1.10",
      ipv6: null,
    });
  });

  test("drops reported and transport IPv4 from documentation ranges", () => {
    expect(
      resolveAgentIpFamilies({
        reportedIpv4: "192.0.2.10",
        reportedIpv6: null,
        transportIp: "198.51.100.50",
      }),
    ).toEqual({
      ipv4: null,
      ipv6: null,
    });
  });
});

describe("isReportableIp", () => {
  test("accepts globally routable IPv4 and IPv6", () => {
    expect(isReportableIp("8.8.8.8")).toBe(true);
    expect(isReportableIp("2001:4860:4860::8888")).toBe(true);
  });

  test("accepts RFC 1918 / RFC 6598 / ULA private ranges", () => {
    expect(isReportableIp("10.0.0.1")).toBe(true);
    expect(isReportableIp("172.16.0.1")).toBe(true);
    expect(isReportableIp("192.168.1.1")).toBe(true);
    expect(isReportableIp("100.64.0.1")).toBe(true);
    expect(isReportableIp("fd12:3456:789a::1")).toBe(true);
  });

  test("rejects link-local addresses", () => {
    expect(isReportableIp("169.254.1.1")).toBe(false);
    expect(isReportableIp("169.254.169.254")).toBe(false);
    expect(isReportableIp("fe80::1")).toBe(false);
    expect(isReportableIp("fe80::abcd:1234")).toBe(false);
    expect(isReportableIp("febf:ffff::1")).toBe(false); // upper bound of fe80::/10
  });

  test("rejects loopback and unspecified", () => {
    expect(isReportableIp("127.0.0.1")).toBe(false);
    expect(isReportableIp("0.0.0.0")).toBe(false);
    expect(isReportableIp("::1")).toBe(false);
    expect(isReportableIp("::")).toBe(false);
  });

  test("rejects multicast", () => {
    expect(isReportableIp("224.0.0.1")).toBe(false);
    expect(isReportableIp("239.0.0.1")).toBe(false);
    expect(isReportableIp("ff02::1")).toBe(false);
  });

  test("rejects documentation ranges (IPv4 TEST-NET and IPv6 2001:db8::/32)", () => {
    // IPv4 RFC 5737 TEST-NET-1/2/3
    expect(isReportableIp("192.0.2.1")).toBe(false);
    expect(isReportableIp("192.0.2.255")).toBe(false);
    expect(isReportableIp("198.51.100.1")).toBe(false);
    expect(isReportableIp("198.51.100.254")).toBe(false);
    expect(isReportableIp("203.0.113.1")).toBe(false);
    expect(isReportableIp("203.0.113.200")).toBe(false);
    // Adjacent ranges remain reportable
    expect(isReportableIp("192.0.3.1")).toBe(true);
    expect(isReportableIp("198.52.100.1")).toBe(true);
    expect(isReportableIp("203.0.114.1")).toBe(true);
    // IPv6 RFC 3849 documentation
    expect(isReportableIp("2001:db8::1")).toBe(false);
  });

  test("rejects reserved IPv4 (benchmarking, IETF protocol assignments, future use)", () => {
    expect(isReportableIp("198.18.0.1")).toBe(false); // 198.18.0.0/15 benchmarking
    expect(isReportableIp("198.19.255.254")).toBe(false);
    expect(isReportableIp("192.0.0.1")).toBe(false); // 192.0.0.0/24 IETF protocol assignments
    expect(isReportableIp("192.0.0.11")).toBe(false);
    expect(isReportableIp("240.0.0.1")).toBe(false); // 240.0.0.0/4 future use
    expect(isReportableIp("255.255.255.255")).toBe(false); // limited broadcast
  });

  test("accepts globally-reachable anycast inside 192.0.0.0/24 (PCP, TURN)", () => {
    expect(isReportableIp("192.0.0.9")).toBe(true);
    expect(isReportableIp("192.0.0.10")).toBe(true);
  });

  test("collapses IPv4-mapped IPv6 to the embedded IPv4 reportability", () => {
    expect(isReportableIp("::ffff:8.8.8.8")).toBe(true);
    expect(isReportableIp("::ffff:192.168.1.1")).toBe(true);
    expect(isReportableIp("::ffff:127.0.0.1")).toBe(false);
    expect(isReportableIp("::ffff:169.254.1.1")).toBe(false);
  });

  test("rejects invalid input", () => {
    expect(isReportableIp("not-an-ip")).toBe(false);
    expect(isReportableIp("")).toBe(false);
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

describe("classifyIp", () => {
  test("classifies globally routable addresses as global", () => {
    expect(classifyIp("8.8.8.8")).toBe("global");
    expect(classifyIp("157.254.18.138")).toBe("global");
    expect(classifyIp("2001:4860:4860::8888")).toBe("global");
    expect(classifyIp("2a14:7586:1cfc::1")).toBe("global");
    expect(classifyIp("192.0.0.9")).toBe("global"); // PCP anycast
    expect(classifyIp("192.0.0.10")).toBe("global"); // TURN anycast
  });

  test("classifies RFC 1918 / RFC 6598 / ULA as private", () => {
    expect(classifyIp("10.0.0.1")).toBe("private");
    expect(classifyIp("172.16.0.1")).toBe("private");
    expect(classifyIp("172.31.255.255")).toBe("private");
    expect(classifyIp("192.168.1.1")).toBe("private");
    expect(classifyIp("100.64.0.1")).toBe("private");
    expect(classifyIp("100.127.255.255")).toBe("private");
    expect(classifyIp("fc00::1")).toBe("private");
    expect(classifyIp("fd12:3456:789a::1")).toBe("private");
  });

  test("classifies link-local addresses", () => {
    expect(classifyIp("169.254.1.1")).toBe("link-local");
    expect(classifyIp("fe80::1")).toBe("link-local");
    expect(classifyIp("febf:ffff::1")).toBe("link-local");
  });

  test("classifies loopback and unspecified", () => {
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("::1")).toBe("loopback");
    expect(classifyIp("0.0.0.0")).toBe("unspecified");
    expect(classifyIp("::")).toBe("unspecified");
  });

  test("classifies multicast", () => {
    expect(classifyIp("224.0.0.1")).toBe("multicast");
    expect(classifyIp("239.255.255.255")).toBe("multicast");
    expect(classifyIp("ff02::1")).toBe("multicast");
  });

  test("classifies documentation ranges", () => {
    expect(classifyIp("192.0.2.1")).toBe("documentation");
    expect(classifyIp("198.51.100.1")).toBe("documentation");
    expect(classifyIp("203.0.113.1")).toBe("documentation");
    expect(classifyIp("2001:db8::1")).toBe("documentation");
  });

  test("classifies reserved ranges", () => {
    expect(classifyIp("198.18.0.1")).toBe("reserved"); // benchmarking
    expect(classifyIp("198.19.255.254")).toBe("reserved");
    expect(classifyIp("192.0.0.1")).toBe("reserved"); // IETF protocol assignments
    expect(classifyIp("192.0.0.11")).toBe("reserved");
    expect(classifyIp("240.0.0.1")).toBe("reserved"); // future use
    expect(classifyIp("255.255.255.255")).toBe("reserved");
  });

  test("delegates IPv4-mapped IPv6 to embedded IPv4 scope", () => {
    expect(classifyIp("::ffff:8.8.8.8")).toBe("global");
    expect(classifyIp("::ffff:10.0.0.1")).toBe("private");
    expect(classifyIp("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyIp("::ffff:169.254.1.1")).toBe("link-local");
    expect(classifyIp("::ffff:203.0.113.1")).toBe("documentation");
  });

  test("returns invalid for unparseable input", () => {
    expect(classifyIp("not-an-ip")).toBe("invalid");
    expect(classifyIp("")).toBe("invalid");
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
        reportedIpv6: "8.8.8.8",
        transportIp: "104.16.0.1",
      }),
    ).toBe("104.16.0.1");
  });
});
