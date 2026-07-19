import { describe, expect, test } from "bun:test";
import {
  canonicalizeAsn,
  extractRouteObservation,
  isSignatureSubsequence,
} from "./traceroute-route";

function makeHops(asns: (number | null)[]) {
  return asns.map((asn, i) => ({
    ttl: i + 1,
    responses:
      asn === null
        ? [] // timeout
        : [{ ip: `10.0.0.${i + 1}`, asn_info: { asn } }],
    timeouts: asn === null ? 1 : 0,
  }));
}

function makeTracerouteJson(asns: (number | null)[]): string {
  return JSON.stringify({ kind: "traceroute", v: 1, hops: makeHops(asns) });
}

function makeV2TracerouteJson(
  traces: Array<{ packetSizeBytes: number; asns: (number | null)[] }>,
): string {
  return JSON.stringify({
    kind: "traceroute",
    v: 2,
    traces: traces.map((t) => ({
      packet_size_bytes: t.packetSizeBytes,
      hops: makeHops(t.asns),
    })),
  });
}

describe("canonicalizeAsn", () => {
  test("maps AS10099 to AS4837 (China Unicom equivalence)", () => {
    expect(canonicalizeAsn(10099)).toBe(4837);
  });

  test("keeps AS4837 as-is", () => {
    expect(canonicalizeAsn(4837)).toBe(4837);
  });

  test("does not touch unrelated ASNs", () => {
    expect(canonicalizeAsn(4134)).toBe(4134);
    expect(canonicalizeAsn(9929)).toBe(9929);
    expect(canonicalizeAsn(58453)).toBe(58453);
    expect(canonicalizeAsn(58807)).toBe(58807);
  });
});

describe("extractRouteObservation", () => {
  test("returns null for null/empty/invalid input", () => {
    expect(extractRouteObservation(null)).toBeNull();
    expect(extractRouteObservation("")).toBeNull();
    expect(extractRouteObservation("not json")).toBeNull();
    expect(extractRouteObservation(JSON.stringify({ kind: "http" }))).toBeNull();
  });

  test("extracts basic ASN path", () => {
    const obs = extractRouteObservation(makeTracerouteJson([749, 6939, 13335]));
    expect(obs).not.toBeNull();
    expect(obs!.rawAsnPath).toEqual([749, 6939, 13335]);
    expect(obs!.normalizedAsnPath).toEqual([749, 6939, 13335]);
    expect(obs!.signature).toBe("749,6939,13335");
    expect(obs!.quality).toBe("strong");
  });

  test("deduplicates consecutive same-AS hops in raw path", () => {
    const obs = extractRouteObservation(makeTracerouteJson([749, 749, 6939]));
    expect(obs!.rawAsnPath).toEqual([749, 6939]);
    expect(obs!.signature).toBe("749,6939");
  });

  test("skips timeout hops", () => {
    const obs = extractRouteObservation(makeTracerouteJson([749, null, 6939]));
    expect(obs!.rawAsnPath).toEqual([749, 6939]);
    expect(obs!.signature).toBe("749,6939");
  });

  test("normalizes AS10099 → AS4837 in signature", () => {
    const obs = extractRouteObservation(makeTracerouteJson([749, 10099, 4134]));
    expect(obs!.rawAsnPath).toEqual([749, 10099, 4134]);
    expect(obs!.normalizedAsnPath).toEqual([749, 4837, 4134]);
    expect(obs!.signature).toBe("749,4837,4134");
  });

  test("AS10099 and AS4837 produce identical signatures", () => {
    const obsA = extractRouteObservation(makeTracerouteJson([749, 10099, 4134]));
    const obsB = extractRouteObservation(makeTracerouteJson([749, 4837, 4134]));
    expect(obsA!.signature).toBe(obsB!.signature);
  });

  test("consecutive AS10099+AS4837 collapse to single AS4837", () => {
    const obs = extractRouteObservation(makeTracerouteJson([749, 10099, 4837, 4134]));
    expect(obs!.normalizedAsnPath).toEqual([749, 4837, 4134]);
    expect(obs!.signature).toBe("749,4837,4134");
  });

  test("single-ASN path is usable, not strong", () => {
    const obs = extractRouteObservation(makeTracerouteJson([4837]));
    expect(obs!.quality).toBe("usable");
  });

  test("2+ ASN path is strong", () => {
    const obs = extractRouteObservation(makeTracerouteJson([749, 4837]));
    expect(obs!.quality).toBe("strong");
  });

  test("returns null when no ASN info at all", () => {
    const obs = extractRouteObservation(makeTracerouteJson([null, null, null]));
    expect(obs).toBeNull();
  });
});

describe("extractRouteObservation v2 (packet-size traces)", () => {
  test("uses the smaller packet_size_bytes trace's hops when traces diverge", () => {
    const json = makeV2TracerouteJson([
      { packetSizeBytes: 1400, asns: [749, 6939] },
      { packetSizeBytes: 64, asns: [749, 4837] },
    ]);
    const obs = extractRouteObservation(json);
    expect(obs).not.toBeNull();
    // Smaller trace (64 bytes) has [749, 4837], not the 1400-byte trace's [749, 6939].
    expect(obs!.rawAsnPath).toEqual([749, 4837]);
    expect(obs!.signature).toBe("749,4837");
  });

  test("smaller-size selection is independent of trace array order", () => {
    const json = makeV2TracerouteJson([
      { packetSizeBytes: 64, asns: [1, 2] },
      { packetSizeBytes: 1400, asns: [1, 3] },
    ]);
    const obs = extractRouteObservation(json);
    expect(obs!.rawAsnPath).toEqual([1, 2]);
  });

  test("ignores traces missing packet_size_bytes or hops", () => {
    const json = JSON.stringify({
      kind: "traceroute",
      v: 2,
      traces: [
        { hops: makeHops([749, 4134]) }, // missing packet_size_bytes — skipped
        { packet_size_bytes: 1400, asns: [749, 6939] }, // missing hops — skipped
        { packet_size_bytes: 64, hops: makeHops([749, 4837]) },
      ],
    });
    const obs = extractRouteObservation(json);
    expect(obs!.rawAsnPath).toEqual([749, 4837]);
  });

  test("does not fall back to the larger trace when the smaller one has no ASN data", () => {
    const json = makeV2TracerouteJson([
      { packetSizeBytes: 64, asns: [null, null] },
      { packetSizeBytes: 1400, asns: [749, 4837] },
    ]);
    // The smaller trace (64 bytes) is still the one selected, even though it
    // has no usable ASN info — the spec says "use the smaller trace", not
    // "use whichever trace looks better".
    const obs = extractRouteObservation(json);
    expect(obs).toBeNull();
  });

  test("returns null when no trace has any ASN info", () => {
    const json = makeV2TracerouteJson([
      { packetSizeBytes: 64, asns: [null, null] },
      { packetSizeBytes: 1400, asns: [null, null] },
    ]);
    expect(extractRouteObservation(json)).toBeNull();
  });

  test("does not use v1's top-level hops when v is 2", () => {
    const json = JSON.stringify({
      kind: "traceroute",
      v: 2,
      hops: makeHops([1, 2, 3]), // malformed for v2, must not be picked up
      traces: [{ packet_size_bytes: 64, hops: makeHops([9, 8]) }],
    });
    const obs = extractRouteObservation(json);
    expect(obs!.rawAsnPath).toEqual([9, 8]);
  });
});

describe("isSignatureSubsequence", () => {
  test("shorter is subsequence of longer", () => {
    expect(isSignatureSubsequence("749,4134", "749,4837,4134")).toBe(true);
  });

  test("symmetric: works regardless of argument order", () => {
    expect(isSignatureSubsequence("749,4837,4134", "749,4134")).toBe(true);
  });

  test("equal signatures are not a subsequence", () => {
    expect(isSignatureSubsequence("749,4837,4134", "749,4837,4134")).toBe(false);
  });

  test("same length, different content is not a subsequence", () => {
    expect(isSignatureSubsequence("749,4837,4134", "749,3356,4134")).toBe(false);
  });

  test("order matters", () => {
    expect(isSignatureSubsequence("749,4837", "4837,749")).toBe(false);
  });

  test("not a subsequence when elements differ", () => {
    expect(isSignatureSubsequence("10099", "749,4837")).toBe(false);
  });

  test("multiple hops dropped but still subsequence", () => {
    expect(isSignatureSubsequence("749,3356,4837,4134", "749,4134")).toBe(true);
  });
});
