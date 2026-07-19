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
