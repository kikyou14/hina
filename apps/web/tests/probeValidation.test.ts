import { describe, expect, test } from "bun:test";

import {
  isTcpTracerouteTarget,
  isValidPort,
  isValidTracerouteTcpPacketSize,
  parseIntegerInput,
  parseTracerouteTcpPacketSizes,
  tracerouteProtocolOfTarget,
  TRACEROUTE_TCP_PACKET_SIZE_MAX,
  TRACEROUTE_TCP_PACKET_SIZE_MIN,
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

describe("isValidTracerouteTcpPacketSize", () => {
  test("accepts the 40-1500 boundary", () => {
    expect(isValidTracerouteTcpPacketSize(TRACEROUTE_TCP_PACKET_SIZE_MIN)).toBe(true);
    expect(isValidTracerouteTcpPacketSize(TRACEROUTE_TCP_PACKET_SIZE_MAX)).toBe(true);
    expect(isValidTracerouteTcpPacketSize(64)).toBe(true);
  });

  test("rejects values outside 40-1500 or non-integers", () => {
    expect(isValidTracerouteTcpPacketSize(39)).toBe(false);
    expect(isValidTracerouteTcpPacketSize(1501)).toBe(false);
    expect(isValidTracerouteTcpPacketSize(64.5)).toBe(false);
    expect(isValidTracerouteTcpPacketSize(Number.NaN)).toBe(false);
  });
});

describe("parseTracerouteTcpPacketSizes", () => {
  test("keeps an already-ascending pair", () => {
    expect(parseTracerouteTcpPacketSizes(64, 1400)).toEqual([64, 1400]);
  });

  test("normalizes a descending pair to ascending order", () => {
    expect(parseTracerouteTcpPacketSizes(1400, 64)).toEqual([64, 1400]);
  });

  test("accepts the boundary values 40 and 1500", () => {
    expect(parseTracerouteTcpPacketSizes(40, 1500)).toEqual([40, 1500]);
  });

  test("rejects equal sizes", () => {
    expect(parseTracerouteTcpPacketSizes(64, 64)).toBeNull();
  });

  test("rejects a size below the minimum", () => {
    expect(parseTracerouteTcpPacketSizes(39, 1400)).toBeNull();
  });

  test("rejects a size above the maximum", () => {
    expect(parseTracerouteTcpPacketSizes(64, 1501)).toBeNull();
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
