import { describe, expect, test } from "bun:test";

import {
  PUBLIC_TRACEROUTE_IP_MASK,
  anonymizeTracerouteExtraForPublic,
  isPrivateIp,
  sanitizeTracerouteExtraRawJsonForPublic,
  stripTracerouteAsnInfo,
} from "./traceroute-privacy";

describe("isPrivateIp", () => {
  test.each([
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["192.168.0.1", true],
    ["192.168.255.255", true],
    ["169.254.1.1", true],
    ["127.0.0.1", true],
    ["127.255.255.255", true],
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["203.0.113.1", false],
    ["::1", true],
    ["fc00::1", true],
    ["fd12::1", true],
    ["fe80::1", true],
    ["2001:db8::1", false],
  ])("%s → %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

describe("stripTracerouteAsnInfo", () => {
  test("removes asn_info and destination_asn_info keys recursively", () => {
    const value = {
      kind: "traceroute",
      v: 1,
      destination_asn_info: { asn: 13335, name: "CLOUDFLARENET" },
      hops: [
        {
          ttl: 1,
          responses: [
            {
              ip: "1.1.1.1",
              hostname: "one.one.one.one",
              asn_info: { asn: 13335, name: "CLOUDFLARENET" },
            },
          ],
        },
      ],
    };

    const out = stripTracerouteAsnInfo(value) as typeof value;
    expect(Object.prototype.hasOwnProperty.call(out, "destination_asn_info")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out.hops[0]!.responses[0]!, "asn_info")).toBe(
      false,
    );
    expect(out.hops[0]!.responses[0]!.hostname).toBe("one.one.one.one");
  });

  test("treats __proto__ as a normal key without prototype mutation", () => {
    const value = JSON.parse(
      '{"__proto__":{"polluted":true},"destination_asn_info":{"asn":1},"hops":[{"responses":[{"asn_info":{"asn":2},"ip":"1.1.1.1"}]}]}',
    ) as Record<string, unknown>;
    const out = stripTracerouteAsnInfo(value) as Record<string, unknown>;

    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, "__proto__")).toBe(true);
    expect((out as unknown as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as unknown as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe("anonymizeTracerouteExtraForPublic", () => {
  const baseValue = {
    target: "example.com",
    target_ip: "8.8.8.8",
    origin_ip: "10.0.0.1",
    destination_asn_info: { asn: 15169, name: "GOOGLE" },
    hops: [
      {
        ttl: 1,
        responses: [
          {
            ip: "1.1.1.1",
            hostname: "one.one.one.one",
            asn_info: { asn: 13335, name: "CLOUDFLARENET" },
          },
        ],
      },
    ],
  };

  test("nulls IP fields and strips ASN + hostname when revealHopDetails is off", () => {
    const out = anonymizeTracerouteExtraForPublic(baseValue, {
      revealHopDetails: false,
    }) as typeof baseValue;

    expect(out.target).toBeNull();
    expect(out.target_ip).toBeNull();
    expect(out.origin_ip).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(out, "destination_asn_info")).toBe(false);
    expect(out.hops[0]!.responses[0]!.ip).toBeNull();
    expect(out.hops[0]!.responses[0]!.hostname).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(out.hops[0]!.responses[0]!, "asn_info")).toBe(
      false,
    );
  });

  test("nulls IP fields, always strips destination_asn_info, keeps hop ASN + hostname when revealHopDetails is on", () => {
    const out = anonymizeTracerouteExtraForPublic(baseValue, {
      revealHopDetails: true,
    }) as typeof baseValue;

    expect(out.target).toBeNull();
    expect(out.target_ip).toBeNull();
    expect(out.origin_ip).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(out, "destination_asn_info")).toBe(false);
    expect(out.hops[0]!.responses[0]!.ip).toBeNull();
    expect(out.hops[0]!.responses[0]!.hostname).toBe("one.one.one.one");
    expect(out.hops[0]!.responses[0]!.asn_info).toEqual({
      asn: 13335,
      name: "CLOUDFLARENET",
    });
  });

  test("filters out hops where all responses have private IPs", () => {
    const value = {
      target: "example.com",
      target_ip: "8.8.8.8",
      origin_ip: null,
      hops: [
        { ttl: 1, responses: [{ ip: "192.168.1.1", hostname: "gateway" }] },
        { ttl: 2, responses: [{ ip: "10.0.0.1", hostname: "internal" }] },
        { ttl: 3, responses: [] }, // timeout — kept
        { ttl: 4, responses: [{ ip: "1.1.1.1", hostname: "one.one.one.one" }] },
      ],
    };

    const out = anonymizeTracerouteExtraForPublic(value, {
      revealHopDetails: true,
    }) as typeof value;

    expect(out.hops).toHaveLength(2);
    expect((out.hops[0] as Record<string, unknown>).ttl).toBe(3);
    expect((out.hops[1] as Record<string, unknown>).ttl).toBe(4);
  });

  test("keeps hops with mixed private and public responses", () => {
    const value = {
      target: "example.com",
      target_ip: "8.8.8.8",
      origin_ip: null,
      hops: [
        {
          ttl: 1,
          responses: [
            { ip: "192.168.1.1", hostname: "gw" },
            { ip: "203.0.113.1", hostname: "pub" },
          ],
        },
      ],
    };

    const out = anonymizeTracerouteExtraForPublic(value, {
      revealHopDetails: true,
    }) as typeof value;

    expect(out.hops).toHaveLength(1);
  });

  test("strips hostname and asn_info from destination hop when destination_reached is true", () => {
    const value = {
      target: "dns.google",
      target_ip: "8.8.8.8",
      origin_ip: null,
      destination_reached: true,
      hops: [
        {
          ttl: 1,
          responses: [
            {
              ip: "203.0.113.1",
              hostname: "isp-router.example.com",
              asn_info: { asn: 12345, name: "ISP" },
            },
          ],
        },
        {
          ttl: 2,
          responses: [
            { ip: "8.8.8.8", hostname: "dns.google", asn_info: { asn: 15169, name: "GOOGLE" } },
          ],
        },
      ],
    };

    const out = anonymizeTracerouteExtraForPublic(value, {
      revealHopDetails: true,
    }) as Record<string, unknown>;

    const hops = out.hops as Array<Record<string, unknown>>;
    expect(hops).toHaveLength(2);

    // Intermediate hop: hostname and asn_info preserved (toggle is on)
    const hop1Resp = (hops[0].responses as Array<Record<string, unknown>>)[0];
    expect(hop1Resp.hostname).toBe("isp-router.example.com");
    expect(hop1Resp.asn_info).toEqual({ asn: 12345, name: "ISP" });

    // Destination hop: hostname and asn_info always nulled
    const hop2Resp = (hops[1].responses as Array<Record<string, unknown>>)[0];
    expect(hop2Resp.hostname).toBeNull();
    expect(hop2Resp.asn_info).toBeNull();
  });

  test("does not strip last hop details when destination_reached is false", () => {
    const value = {
      target: "unreachable.example",
      target_ip: "192.0.2.1",
      origin_ip: null,
      destination_reached: false,
      hops: [
        {
          ttl: 1,
          responses: [
            {
              ip: "203.0.113.1",
              hostname: "router.example.com",
              asn_info: { asn: 100, name: "NET" },
            },
          ],
        },
      ],
    };

    const out = anonymizeTracerouteExtraForPublic(value, {
      revealHopDetails: true,
    }) as Record<string, unknown>;

    const hops = out.hops as Array<Record<string, unknown>>;
    const resp = (hops[0].responses as Array<Record<string, unknown>>)[0];
    expect(resp.hostname).toBe("router.example.com");
    expect(resp.asn_info).toEqual({ asn: 100, name: "NET" });
  });
});

describe("anonymizeTracerouteExtraForPublic v2 (traces)", () => {
  const v2Value = {
    target: "example.com",
    target_ip: "8.8.8.8",
    origin_ip: "10.0.0.1",
    destination_asn_info: { asn: 15169, name: "GOOGLE" },
    traces: [
      {
        packet_size_bytes: 64,
        destination_reached: true,
        hops: [
          {
            ttl: 1,
            responses: [
              {
                ip: "1.1.1.1",
                hostname: "one.one.one.one",
                asn_info: { asn: 13335, name: "CLOUDFLARENET" },
              },
            ],
          },
          {
            ttl: 2,
            responses: [
              { ip: "8.8.8.8", hostname: "dns.google", asn_info: { asn: 15169, name: "GOOGLE" } },
            ],
          },
        ],
      },
      {
        packet_size_bytes: 1400,
        destination_reached: false,
        hops: [
          {
            ttl: 1,
            responses: [
              {
                ip: "1.1.1.1",
                hostname: "one.one.one.one",
                asn_info: { asn: 13335, name: "CLOUDFLARENET" },
              },
            ],
          },
        ],
      },
    ],
  };

  test("has no top-level hops and does not throw", () => {
    expect(() =>
      anonymizeTracerouteExtraForPublic(v2Value, { revealHopDetails: true }),
    ).not.toThrow();
  });

  test("nulls top-level target/target_ip/origin_ip and drops destination_asn_info", () => {
    const out = anonymizeTracerouteExtraForPublic(v2Value, {
      revealHopDetails: true,
    }) as Record<string, unknown>;

    expect(out.target).toBeNull();
    expect(out.target_ip).toBeNull();
    expect(out.origin_ip).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(out, "destination_asn_info")).toBe(false);
  });

  test("nulls ip and strips hostname/asn_info on every trace when revealHopDetails is off", () => {
    const out = anonymizeTracerouteExtraForPublic(v2Value, {
      revealHopDetails: false,
    }) as { traces: Array<Record<string, unknown>> };

    for (const trace of out.traces) {
      const hops = trace.hops as Array<Record<string, unknown>>;
      for (const hop of hops) {
        for (const resp of hop.responses as Array<Record<string, unknown>>) {
          expect(resp.ip).toBeNull();
          expect(resp.hostname).toBeNull();
          expect(Object.prototype.hasOwnProperty.call(resp, "asn_info")).toBe(false);
        }
      }
    }
  });

  test("strips destination-hop hostname/asn_info per-trace using that trace's own destination_reached", () => {
    const out = anonymizeTracerouteExtraForPublic(v2Value, {
      revealHopDetails: true,
    }) as { traces: Array<Record<string, unknown>> };

    // Trace 0: destination_reached true — last hop (dns.google) is the
    // destination and must have hostname/asn_info stripped despite
    // revealHopDetails: true.
    const trace0Hops = out.traces[0]!.hops as Array<Record<string, unknown>>;
    const trace0Last = (trace0Hops[1]!.responses as Array<Record<string, unknown>>)[0]!;
    expect(trace0Last.hostname).toBeNull();
    expect(trace0Last.asn_info).toBeNull();
    // Non-destination hop in the same trace keeps its details.
    const trace0First = (trace0Hops[0]!.responses as Array<Record<string, unknown>>)[0]!;
    expect(trace0First.hostname).toBe("one.one.one.one");
    expect(trace0First.asn_info).toEqual({ asn: 13335, name: "CLOUDFLARENET" });

    // Trace 1: destination_reached false — its last hop is untouched even
    // though trace 0 reached the destination.
    const trace1Hops = out.traces[1]!.hops as Array<Record<string, unknown>>;
    const trace1Last = (trace1Hops[0]!.responses as Array<Record<string, unknown>>)[0]!;
    expect(trace1Last.hostname).toBe("one.one.one.one");
    expect(trace1Last.asn_info).toEqual({ asn: 13335, name: "CLOUDFLARENET" });
  });

  test("filters private-only hops independently per trace", () => {
    const value = {
      target: "example.com",
      target_ip: "8.8.8.8",
      origin_ip: null,
      traces: [
        {
          packet_size_bytes: 64,
          destination_reached: false,
          hops: [
            { ttl: 1, responses: [{ ip: "192.168.1.1", hostname: "gw" }] },
            { ttl: 2, responses: [{ ip: "1.1.1.1", hostname: "one.one.one.one" }] },
          ],
        },
        {
          packet_size_bytes: 1400,
          destination_reached: false,
          hops: [{ ttl: 1, responses: [{ ip: "10.0.0.1", hostname: "internal" }] }],
        },
      ],
    };

    const out = anonymizeTracerouteExtraForPublic(value, {
      revealHopDetails: true,
    }) as { traces: Array<{ hops: unknown[] }> };

    expect(out.traces[0]!.hops).toHaveLength(1);
    expect(out.traces[1]!.hops).toHaveLength(0);
  });

  test("downgrades comparison when private-only divergence evidence is removed", () => {
    const value = {
      comparison: { comparable: true, route_diverged: true, first_diverging_ttl: 1 },
      traces: [
        {
          packet_size_bytes: 64,
          hops: [{ ttl: 1, responses: [{ ip: "192.168.1.1" }] }],
        },
        {
          packet_size_bytes: 1400,
          hops: [{ ttl: 1, responses: [{ ip: "10.0.0.1" }] }],
        },
      ],
    };

    const out = anonymizeTracerouteExtraForPublic(value, {
      revealHopDetails: true,
    }) as {
      comparison: {
        comparable: boolean;
        route_diverged: boolean;
        first_diverging_ttl: number | null;
      };
      traces: Array<{ hops: unknown[] }>;
    };

    expect(out.traces.map((trace) => trace.hops)).toEqual([[], []]);
    expect(out.comparison).toEqual({
      comparable: false,
      route_diverged: false,
      first_diverging_ttl: null,
    });
  });

  test("recomputes the first divergence from remaining public hops", () => {
    const value = {
      comparison: { comparable: true, route_diverged: true, first_diverging_ttl: 1 },
      traces: [
        {
          packet_size_bytes: 64,
          hops: [
            { ttl: 1, responses: [{ ip: "192.168.1.1" }] },
            { ttl: 2, responses: [{ ip: "1.1.1.1" }] },
            { ttl: 3, responses: [{ ip: "203.0.113.1" }] },
          ],
        },
        {
          packet_size_bytes: 1400,
          hops: [
            { ttl: 1, responses: [{ ip: "10.0.0.1" }] },
            { ttl: 2, responses: [{ ip: "1.1.1.1" }] },
            { ttl: 3, responses: [{ ip: "203.0.113.2" }] },
          ],
        },
      ],
    };

    const out = anonymizeTracerouteExtraForPublic(value, {
      revealHopDetails: true,
    }) as Record<string, unknown>;

    expect(out.comparison).toEqual({
      comparable: true,
      route_diverged: true,
      first_diverging_ttl: 3,
    });
  });

  test("does not treat the frag-needed reporter hop as divergence evidence", () => {
    // The large trace's TTL-4 entry is the Fragmentation Needed reporter (the
    // TTL-3 router answering at forwarding time); comparing it against the
    // small trace's genuine TTL-4 hop would fabricate a fork.
    const value = {
      comparison: { comparable: true, route_diverged: true, first_diverging_ttl: 4 },
      traces: [
        {
          packet_size_bytes: 64,
          hops: [
            { ttl: 3, responses: [{ ip: "203.0.113.3" }] },
            { ttl: 4, responses: [{ ip: "203.0.113.4" }] },
          ],
        },
        {
          packet_size_bytes: 1400,
          error_code: "packet_too_large",
          frag_hop_ttl: 4,
          hops: [
            { ttl: 3, responses: [{ ip: "203.0.113.3" }] },
            { ttl: 4, responses: [{ ip: "203.0.113.3" }] },
          ],
        },
      ],
    };

    const out = anonymizeTracerouteExtraForPublic(value, {
      revealHopDetails: true,
    }) as Record<string, unknown>;

    expect(out.comparison).toEqual({
      comparable: true,
      route_diverged: false,
      first_diverging_ttl: null,
    });
  });

  test("does not treat a timeout as public divergence evidence", () => {
    const value = {
      comparison: { comparable: true, route_diverged: true, first_diverging_ttl: 2 },
      traces: [
        {
          packet_size_bytes: 64,
          hops: [
            { ttl: 1, responses: [{ ip: "1.1.1.1" }] },
            { ttl: 2, responses: [] },
          ],
        },
        {
          packet_size_bytes: 1400,
          hops: [
            { ttl: 1, responses: [{ ip: "1.1.1.1" }] },
            { ttl: 2, responses: [{ ip: "203.0.113.2" }] },
          ],
        },
      ],
    };

    const out = anonymizeTracerouteExtraForPublic(value, {
      revealHopDetails: true,
    }) as Record<string, unknown>;

    expect(out.comparison).toEqual({
      comparable: true,
      route_diverged: false,
      first_diverging_ttl: null,
    });
  });
});

describe("sanitizeTracerouteExtraRawJsonForPublic", () => {
  const sampleInput =
    '{"target":"example.com","target_ip":"8.8.8.8","origin_ip":"10.0.0.1","hops":[{"ttl":1,"responses":[{"ip":"1.1.1.1","hostname":"one.one.one.one","asn_info":{"asn":13335,"prefix":"1.1.1.0/24","country_code":"US","registry":"APNIC","name":"CLOUDFLARENET"}}]}],"destination_asn_info":{"asn":15169,"prefix":"8.8.8.0/24","country_code":"US","registry":"ARIN","name":"GOOGLE"}}';

  test("nulls IP fields, strips hostname + ASN when revealHopDetails is off", () => {
    const out = sanitizeTracerouteExtraRawJsonForPublic(sampleInput, {
      revealHopDetails: false,
    });

    expect(out).toContain('"target":null');
    expect(out).toContain('"target_ip":null');
    expect(out).toContain('"origin_ip":null');
    expect(out).toContain('"ip":null');
    expect(out).toContain('"hostname":null');
    expect(out).toContain('"asn_info":null');
    expect(out).toContain('"destination_asn_info":null');
    expect(out).not.toContain("CLOUDFLARENET");
    expect(out).not.toContain("GOOGLE");
    expect(out).not.toContain("one.one.one.one");
  });

  test("nulls IP fields, always strips destination_asn_info, keeps hop ASN + hostname when revealHopDetails is on", () => {
    const out = sanitizeTracerouteExtraRawJsonForPublic(sampleInput, {
      revealHopDetails: true,
    });

    expect(out).toContain('"target":null');
    expect(out).toContain('"target_ip":null');
    expect(out).toContain('"origin_ip":null');
    expect(out).toContain('"ip":null');
    expect(out).toContain("one.one.one.one");
    expect(out).toContain("CLOUDFLARENET");
    expect(out).toContain('"destination_asn_info":null');
    expect(out).not.toContain("GOOGLE");
    expect(out).not.toContain('"asn_info":null');
    expect(out).not.toContain('"hostname":null');
  });

  test("keeps malformed hop IP redacted in fallback output", () => {
    const input = '{"hops":[{"responses":[{"ip":"1.1.1.1';
    const out = sanitizeTracerouteExtraRawJsonForPublic(input, {
      revealHopDetails: false,
    });

    expect(out).not.toContain("1.1.1.1");
    expect(out).toContain('"ip":null');
  });

  test("masks stray IP literals not inside named fields", () => {
    const input = '{"note":"see 203.0.113.5 for details"}';
    const out = sanitizeTracerouteExtraRawJsonForPublic(input, {
      revealHopDetails: false,
    });

    expect(out).not.toContain("203.0.113.5");
    expect(out).toContain(PUBLIC_TRACEROUTE_IP_MASK);
  });

  test("v2 traces[]: nulls/masks nested ip, hostname, and asn_info the same as v1", () => {
    // The regex fallback is structure-agnostic, but verify explicitly since a
    // v2 payload nests the same field names one level deeper (inside `traces`).
    const v2Input =
      '{"target":"example.com","target_ip":"8.8.8.8","origin_ip":"10.0.0.1","traces":[{"packet_size_bytes":64,"hops":[{"ttl":1,"responses":[{"ip":"1.1.1.1","hostname":"one.one.one.one","asn_info":{"asn":13335,"name":"CLOUDFLARENET"}}]}]}],"destination_asn_info":{"asn":15169,"name":"GOOGLE"}}';

    const out = sanitizeTracerouteExtraRawJsonForPublic(v2Input, { revealHopDetails: false });

    expect(out).toContain('"target":null');
    expect(out).toContain('"target_ip":null');
    expect(out).toContain('"origin_ip":null');
    expect(out).toContain('"ip":null');
    expect(out).toContain('"hostname":null');
    expect(out).toContain('"asn_info":null');
    expect(out).toContain('"destination_asn_info":null');
    expect(out).not.toContain("CLOUDFLARENET");
    expect(out).not.toContain("GOOGLE");
    expect(out).not.toContain("one.one.one.one");
    expect(out).not.toContain("1.1.1.1");
  });
});
