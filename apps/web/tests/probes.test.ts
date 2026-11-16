import { describe, expect, test } from "bun:test";

import { formatProbeTarget } from "../src/lib/probes";

describe("formatProbeTarget", () => {
  test("formats a plain icmp traceroute target as the host", () => {
    expect(formatProbeTarget("traceroute", { host: "example.com" })).toBe("example.com");
  });

  test("formats a TCP size-comparison traceroute target as host:port", () => {
    expect(
      formatProbeTarget("traceroute", {
        host: "example.com",
        protocol: "tcp",
        port: 443,
        packetSizes: [64, 1400],
      }),
    ).toBe("example.com:443");
  });

  test("formats a plain tcp probe target as host:port", () => {
    expect(formatProbeTarget("tcp", { host: "example.com", port: 443 })).toBe("example.com:443");
  });

  test.each([40, 1200, 1400])("labels the configured TCP packet size %p", (packetSize) => {
    expect(formatProbeTarget("tcp", { host: "example.com", port: 443, packetSize })).toBe(
      `example.com:443 · ${packetSize}B`,
    );
  });

  test("labels an explicit family and brackets IPv6 literals before the port", () => {
    expect(
      formatProbeTarget("tcp", {
        host: "example.com",
        family: "ipv6",
        port: 443,
        packetSize: 1400,
      }),
    ).toBe("example.com:443 · IPv6 · 1400B");
    expect(formatProbeTarget("tcp", { host: "2001:db8::1", port: 443 })).toBe("[2001:db8::1]:443");
    expect(formatProbeTarget("icmp", { host: "example.com", family: "ipv4" })).toBe(
      "example.com · IPv4",
    );
  });

  test("formats an http target as the url", () => {
    expect(formatProbeTarget("http", { url: "https://example.com/healthz" })).toBe(
      "https://example.com/healthz",
    );
  });

  test("returns a placeholder when kind or target is missing", () => {
    expect(formatProbeTarget(null, { host: "example.com" })).toBe("-");
    expect(formatProbeTarget("traceroute", null)).toBe("-");
  });
});
