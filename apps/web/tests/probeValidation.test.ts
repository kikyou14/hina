import { describe, expect, test } from "bun:test";

import type { AdminAgentOption } from "../src/api/adminAgents";
import {
  familyConflictsWithHost,
  familyOfTarget,
  isTcpTracerouteTarget,
  isValidPort,
  isValidTcpPacketSize,
  parseIntegerInput,
  parseTracerouteTcpPacketSizes,
  probeCapabilitySupport,
  rawTcpFamily,
  requiredProbeCapabilities,
  tcpPacketSizeOfTarget,
  TCP_PACKET_SIZE_MAX,
  TCP_PACKET_SIZE_MIN,
  tracerouteProtocolOfTarget,
  withFamily,
} from "../src/pages/admin/lib/probeValidation";

describe("parseIntegerInput", () => {
  test("honors exponential notation like the browser (not parseInt)", () => {
    // The bug this guards against: parseInt("64e1", 10) === 64, but the number
    // input's actual numeric value is 640.
    expect(parseIntegerInput("64e1")).toBe(640);
    expect(parseIntegerInput("1e3")).toBe(1000);
  });

  test("parses plain integers", () => {
    expect(parseIntegerInput("443")).toBe(443);
    expect(parseIntegerInput("  64  ")).toBe(64);
    expect(parseIntegerInput("0")).toBe(0);
  });

  test("rejects empty, non-numeric, and non-integer input", () => {
    expect(parseIntegerInput("")).toBeNull();
    expect(parseIntegerInput("   ")).toBeNull();
    expect(parseIntegerInput("abc")).toBeNull();
    expect(parseIntegerInput("64px")).toBeNull();
    expect(parseIntegerInput("64.5")).toBeNull();
    expect(parseIntegerInput("Infinity")).toBeNull();
  });
});

describe("isValidPort", () => {
  test("accepts the full 1-65535 range", () => {
    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(443)).toBe(true);
    expect(isValidPort(65535)).toBe(true);
  });

  test("rejects out-of-range or non-integer values", () => {
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(65536)).toBe(false);
    expect(isValidPort(-1)).toBe(false);
    expect(isValidPort(443.5)).toBe(false);
    expect(isValidPort(Number.NaN)).toBe(false);
  });
});

describe("isValidTcpPacketSize", () => {
  test("accepts a bare SYN up to 1500 bytes for each family", () => {
    expect(isValidTcpPacketSize(TCP_PACKET_SIZE_MIN.ipv4, "ipv4")).toBe(true);
    expect(isValidTcpPacketSize(TCP_PACKET_SIZE_MIN.ipv6, "ipv6")).toBe(true);
    expect(isValidTcpPacketSize(TCP_PACKET_SIZE_MAX, "ipv6")).toBe(true);
    expect(isValidTcpPacketSize(64, "ipv4")).toBe(true);
  });

  test("rejects values outside the family's range or non-integers", () => {
    expect(isValidTcpPacketSize(39, "ipv4")).toBe(false);
    // 40 bytes cannot carry an IPv6 header and a TCP header.
    expect(isValidTcpPacketSize(40, "ipv6")).toBe(false);
    expect(isValidTcpPacketSize(59, "ipv6")).toBe(false);
    expect(isValidTcpPacketSize(1501, "ipv4")).toBe(false);
    expect(isValidTcpPacketSize(64.5, "ipv4")).toBe(false);
    expect(isValidTcpPacketSize(Number.NaN, "ipv4")).toBe(false);
  });
});

describe("parseTracerouteTcpPacketSizes", () => {
  test("keeps an already-ascending pair", () => {
    expect(parseTracerouteTcpPacketSizes(64, 1400, "ipv4")).toEqual([64, 1400]);
  });

  test("normalizes a descending pair to ascending order", () => {
    expect(parseTracerouteTcpPacketSizes(1400, 64, "ipv4")).toEqual([64, 1400]);
  });

  test("accepts each family's boundary values", () => {
    expect(parseTracerouteTcpPacketSizes(40, 1500, "ipv4")).toEqual([40, 1500]);
    expect(parseTracerouteTcpPacketSizes(1500, 60, "ipv6")).toEqual([60, 1500]);
  });

  test("rejects equal sizes", () => {
    expect(parseTracerouteTcpPacketSizes(64, 64, "ipv4")).toBeNull();
  });

  test("rejects a size below the family's minimum", () => {
    expect(parseTracerouteTcpPacketSizes(39, 1400, "ipv4")).toBeNull();
    expect(parseTracerouteTcpPacketSizes(40, 1400, "ipv6")).toBeNull();
  });

  test("rejects a size above the maximum", () => {
    expect(parseTracerouteTcpPacketSizes(64, 1501, "ipv4")).toBeNull();
  });
});

describe("isTcpTracerouteTarget", () => {
  test("recognizes the TCP size-comparison target shape", () => {
    expect(
      isTcpTracerouteTarget({
        host: "example.com",
        protocol: "tcp",
        port: 443,
        packetSizes: [64, 1400],
      }),
    ).toBe(true);
  });

  test("rejects the plain icmp/traceroute host-only target", () => {
    expect(isTcpTracerouteTarget({ host: "example.com" })).toBe(false);
  });

  test("rejects the plain tcp probe target (host+port, no protocol)", () => {
    expect(isTcpTracerouteTarget({ host: "example.com", port: 443 })).toBe(false);
  });

  test("rejects the http target", () => {
    expect(isTcpTracerouteTarget({ url: "https://example.com" })).toBe(false);
  });

  test("rejects null and undefined", () => {
    expect(isTcpTracerouteTarget(null)).toBe(false);
    expect(isTcpTracerouteTarget(undefined)).toBe(false);
  });
});

describe("tracerouteProtocolOfTarget", () => {
  test("returns tcp for a TCP size-comparison target", () => {
    expect(
      tracerouteProtocolOfTarget({
        host: "example.com",
        protocol: "tcp",
        port: 443,
        packetSizes: [64, 1400],
      }),
    ).toBe("tcp");
  });

  test("returns icmp for an existing plain-host traceroute target, never auto-upgrading it", () => {
    expect(tracerouteProtocolOfTarget({ host: "example.com" })).toBe("icmp");
  });

  test("returns icmp when there is no existing target (new task)", () => {
    expect(tracerouteProtocolOfTarget(null)).toBe("icmp");
    expect(tracerouteProtocolOfTarget(undefined)).toBe("icmp");
  });
});

describe("address family", () => {
  test("reads the family of a stored target and treats its absence as auto", () => {
    expect(familyOfTarget({ host: "example.com" })).toBe("auto");
    expect(familyOfTarget({ host: "example.com", family: "ipv6" })).toBe("ipv6");
    expect(familyOfTarget({ url: "https://example.com" })).toBe("auto");
    expect(familyOfTarget(null)).toBe("auto");
  });

  test("adds the field only for an explicit family", () => {
    expect(withFamily({ host: "example.com" }, "auto")).toEqual({ host: "example.com" });
    expect(withFamily({ host: "example.com" }, "ipv6")).toEqual({
      host: "example.com",
      family: "ipv6",
    });
  });

  test("flags a family that contradicts an IP literal", () => {
    expect(familyConflictsWithHost("192.0.2.1", "ipv6")).toBe(true);
    expect(familyConflictsWithHost("2001:db8::1", "ipv4")).toBe(true);
    expect(familyConflictsWithHost("2001:db8::1", "ipv6")).toBe(false);
    expect(familyConflictsWithHost("example.com", "ipv6")).toBe(false);
    expect(familyConflictsWithHost("192.0.2.1", "auto")).toBe(false);
  });

  test("raw TCP defaults to IPv4 unless the family or an IPv6 literal says otherwise", () => {
    expect(rawTcpFamily("example.com", "auto")).toBe("ipv4");
    expect(rawTcpFamily("example.com", "ipv6")).toBe("ipv6");
    expect(rawTcpFamily("2001:db8::1", "auto")).toBe("ipv6");
  });
});

describe("TCP packet size and capability support", () => {
  test("reads any stored packet size and keeps connect targets size-less", () => {
    expect(tcpPacketSizeOfTarget({ host: "example.com", port: 443 })).toBeNull();
    expect(tcpPacketSizeOfTarget({ host: "example.com", port: 443, packetSize: 40 })).toBe(40);
    expect(tcpPacketSizeOfTarget({ host: "example.com", port: 443, packetSize: 1400 })).toBe(1400);
  });

  test("requires the same capabilities the server gates on", () => {
    expect(requiredProbeCapabilities("tcp", { host: "example.com", port: 443 })).toEqual([]);
    expect(
      requiredProbeCapabilities("tcp", { host: "example.com", port: 443, packetSize: 1200 }),
    ).toEqual(["tcpPacketSize"]);
    expect(
      requiredProbeCapabilities("tcp", {
        host: "example.com",
        family: "ipv6",
        port: 443,
        packetSize: 1500,
      }),
    ).toEqual(["addressFamily", "tcpPacketSize", "tcpPacketSizeRange", "tcpPacketSizeIpv6"]);
    expect(
      requiredProbeCapabilities("traceroute", {
        host: "2001:db8::1",
        protocol: "tcp",
        port: 443,
        packetSizes: [60, 1500],
      }),
    ).toEqual(["tracerouteTcpSizePair", "tracerouteTcpSizePairIpv6"]);
    expect(requiredProbeCapabilities("traceroute", { host: "2001:db8::1" })).toEqual([
      "tracerouteIcmpIpv6",
    ]);
    expect(requiredProbeCapabilities("icmp", { host: "example.com", family: "ipv6" })).toEqual([
      "addressFamily",
    ]);
  });

  test("counts only the current scope, without including stale selections from other modes", () => {
    const agents: AdminAgentOption[] = [
      {
        id: "linux",
        name: "linux",
        group: "group",
        groupId: "g1",
        probeCapabilities: ["addressFamily", "tcpPacketSize", "tcpPacketSizeIpv6"],
      },
      {
        id: "old",
        name: "old",
        group: "group",
        groupId: "g1",
        probeCapabilities: ["tcpPacketSize"],
      },
      { id: "mac", name: "mac", group: null, groupId: null, probeCapabilities: ["addressFamily"] },
    ];
    const ipv6Syn = ["tcpPacketSize", "tcpPacketSizeIpv6"] as const;
    expect(
      probeCapabilitySupport(
        agents,
        { mode: "specific", agentIds: ["mac"], groupIds: ["g1"] },
        ipv6Syn,
      ),
    ).toEqual({ total: 1, supported: 0 });
    expect(
      probeCapabilitySupport(
        agents,
        { mode: "groups", agentIds: ["mac"], groupIds: ["g1"] },
        ipv6Syn,
      ),
    ).toEqual({ total: 2, supported: 1 });
    expect(
      probeCapabilitySupport(agents, { mode: "all", agentIds: [], groupIds: [] }, [
        "tcpPacketSize",
      ]),
    ).toEqual({ total: 3, supported: 2 });
  });
});
