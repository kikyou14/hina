import { describe, expect, test } from "bun:test";
import { parseTarget } from "./parsing";

describe("parseTarget traceroute — ICMP (default/compat) mode", () => {
  test("missing protocol normalizes to { host }", () => {
    const result = parseTarget("traceroute", { host: "example.com" });
    expect(result).not.toBeNull();
    expect(result!.target).toEqual({ host: "example.com" });
    expect(JSON.parse(result!.targetJson)).toEqual({ host: "example.com" });
  });

  test("explicit protocol: icmp normalizes to { host }, dropping the field", () => {
    const result = parseTarget("traceroute", { host: "example.com", protocol: "icmp" });
    expect(result!.target).toEqual({ host: "example.com" });
  });

  test("rejects IPv6 host literals", () => {
    expect(parseTarget("traceroute", { host: "2001:db8::1" })).toBeNull();
    expect(parseTarget("traceroute", { host: "2001:db8::1", protocol: "icmp" })).toBeNull();
  });

  test("rejects missing or invalid host", () => {
    expect(parseTarget("traceroute", {})).toBeNull();
    expect(parseTarget("traceroute", { host: "" })).toBeNull();
    expect(parseTarget("traceroute", { host: "not a host!" })).toBeNull();
  });

  test("accepts a bare IPv4 host", () => {
    const result = parseTarget("traceroute", { host: "203.0.113.10" });
    expect(result!.target).toEqual({ host: "203.0.113.10" });
  });
});

describe("parseTarget traceroute — TCP dual-size mode", () => {
  function tcpTarget(overrides: Record<string, unknown> = {}) {
    return {
      host: "example.com",
      protocol: "tcp",
      port: 443,
      packetSizes: [64, 1400],
      ...overrides,
    };
  }

  test("accepts a valid TCP target and round-trips through targetJson", () => {
    const result = parseTarget("traceroute", tcpTarget());
    expect(result).not.toBeNull();
    expect(result!.target).toEqual({
      host: "example.com",
      protocol: "tcp",
      port: 443,
      packetSizes: [64, 1400],
    });
    expect(JSON.parse(result!.targetJson)).toEqual(result!.target);
  });

  test("normalizes packetSizes ascending regardless of input order", () => {
    const result = parseTarget("traceroute", tcpTarget({ packetSizes: [1400, 64] }));
    expect(result!.target).toMatchObject({ packetSizes: [64, 1400] });
  });

  test("rejects an IPv6 host even in TCP mode", () => {
    expect(parseTarget("traceroute", tcpTarget({ host: "2001:db8::1" }))).toBeNull();
  });

  test("rejects a missing port", () => {
    const target = tcpTarget();
    delete (target as { port?: unknown }).port;
    expect(parseTarget("traceroute", target)).toBeNull();
  });

  test.each([0, -1, 65536, 1.5, "443", null])("rejects an invalid port %p", (port) => {
    expect(parseTarget("traceroute", tcpTarget({ port }))).toBeNull();
  });

  test("accepts port boundary values 1 and 65535", () => {
    expect(parseTarget("traceroute", tcpTarget({ port: 1 }))).not.toBeNull();
    expect(parseTarget("traceroute", tcpTarget({ port: 65535 }))).not.toBeNull();
  });

  // Each case is wrapped in an extra array layer so it spreads as a single
  // `packetSizes` argument, regardless of the inner array's own length.
  test.each([[[64]], [[64, 128, 1400]], [[]]])(
    "rejects packetSizes with a count other than 2 (%p)",
    (packetSizes) => {
      expect(parseTarget("traceroute", tcpTarget({ packetSizes }))).toBeNull();
    },
  );

  test("rejects duplicate packet sizes", () => {
    expect(parseTarget("traceroute", tcpTarget({ packetSizes: [500, 500] }))).toBeNull();
  });

  test.each([
    [39, 1400],
    [64, 1501],
    [0, 1400],
    [64, 100000],
  ])("rejects out-of-range packet sizes %p", (a, b) => {
    expect(parseTarget("traceroute", tcpTarget({ packetSizes: [a, b] }))).toBeNull();
  });

  test("rejects non-integer packet sizes", () => {
    expect(parseTarget("traceroute", tcpTarget({ packetSizes: [64.5, 1400] }))).toBeNull();
  });

  test("rejects non-numeric packet sizes", () => {
    expect(parseTarget("traceroute", tcpTarget({ packetSizes: ["64", 1400] }))).toBeNull();
  });

  test("accepts packet size boundary values 40 and 1500", () => {
    const result = parseTarget("traceroute", tcpTarget({ packetSizes: [40, 1500] }));
    expect(result!.target).toMatchObject({ packetSizes: [40, 1500] });
  });

  test("rejects any protocol value other than icmp/tcp/undefined", () => {
    expect(parseTarget("traceroute", tcpTarget({ protocol: "udp" }))).toBeNull();
    expect(parseTarget("traceroute", tcpTarget({ protocol: 1 }))).toBeNull();
    expect(parseTarget("traceroute", tcpTarget({ protocol: null }))).toBeNull();
    expect(parseTarget("traceroute", tcpTarget({ protocol: true }))).toBeNull();
  });

  test("does not accept a dontFragment override — the field is silently dropped", () => {
    const result = parseTarget("traceroute", tcpTarget({ dontFragment: false }));
    expect(result!.target).not.toHaveProperty("dontFragment");
  });
});
