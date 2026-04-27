import { describe, expect, test } from "bun:test";
import {
  canonicalizeAsn,
  extractRouteObservation,
  isSignatureSubsequence,
} from "./traceroute-route";

function makeTracerouteJson(asns: (number | null)[]): string {
  const hops = asns.map((asn, i) => ({
    ttl: i + 1,
    responses:
      asn === null
        ? [] // timeout
        : [{ ip: `10.0.0.${i + 1}`, asn_info: { asn } }],
    timeouts: asn === null ? 1 : 0,
  }));
  return JSON.stringify({ kind: "traceroute", v: 1, hops });
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
