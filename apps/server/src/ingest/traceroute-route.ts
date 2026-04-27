const EQUIVALENCE_GROUPS: ReadonlyArray<{ canonical: number; members: readonly number[] }> = [
  // China Unicom: 169 backbone (AS4837) ⟷ CUG international (AS10099)
  { canonical: 4837, members: [4837, 10099] },
];

const ASN_CANONICAL_MAP: ReadonlyMap<number, number> = (() => {
  const m = new Map<number, number>();
  for (const g of EQUIVALENCE_GROUPS) {
    for (const asn of g.members) m.set(asn, g.canonical);
  }
  return m;
})();

export function canonicalizeAsn(asn: number): number {
  return ASN_CANONICAL_MAP.get(asn) ?? asn;
}

export type AsnInfoLike = { asn?: unknown };
export type ResponseLike = { ip?: unknown; asn_info?: unknown };
export type HopLike = { responses?: unknown };
export type TracerouteLike = {
  kind?: unknown;
  hops?: unknown;
  target_ip?: unknown;
  destination_asn_info?: unknown;
};

export type RouteObservation = {
  rawAsnPath: number[];
  normalizedAsnPath: number[];
  signature: string;
  quality: RouteObservationQuality;
};

export type RouteObservationQuality = "unusable" | "usable" | "strong";

export function extractRouteObservation(extraJson: string | null): RouteObservation | null {
  if (!extraJson) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(extraJson);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as TracerouteLike;
  if (obj.kind !== "traceroute") return null;
  if (!Array.isArray(obj.hops)) return null;

  const rawAsnPath = extractRawAsnPath(obj.hops as HopLike[]);
  if (rawAsnPath.length === 0) return null;

  const normalizedAsnPath = normalizeAsnPath(rawAsnPath);
  const signature = normalizedAsnPath.join(",");
  const quality = classifyQuality(normalizedAsnPath);

  return { rawAsnPath, normalizedAsnPath, signature, quality };
}

function extractRawAsnPath(hops: HopLike[]): number[] {
  const path: number[] = [];

  for (const hop of hops) {
    if (typeof hop !== "object" || hop === null) continue;
    if (!Array.isArray(hop.responses)) continue;

    for (const resp of hop.responses as ResponseLike[]) {
      if (typeof resp !== "object" || resp === null) continue;
      const info = resp.asn_info as AsnInfoLike | null | undefined;
      if (typeof info !== "object" || info === null) continue;
      const asn = info.asn;
      if (typeof asn !== "number" || !Number.isFinite(asn)) continue;

      if (path.length === 0 || path[path.length - 1] !== asn) {
        path.push(asn);
      }
      break;
    }
  }

  return path;
}

function normalizeAsnPath(rawPath: number[]): number[] {
  const result: number[] = [];
  for (const asn of rawPath) {
    const canonical = canonicalizeAsn(asn);
    if (result.length === 0 || result[result.length - 1] !== canonical) {
      result.push(canonical);
    }
  }
  return result;
}

function classifyQuality(normalizedPath: number[]): RouteObservationQuality {
  if (normalizedPath.length >= 2) return "strong";
  return "usable";
}

function isOrderedSubsequence(sub: readonly string[], sup: readonly string[]): boolean {
  let si = 0;
  for (let i = 0; i < sup.length && si < sub.length; i++) {
    if (sup[i] === sub[si]) si++;
  }
  return si === sub.length;
}

export function isSignatureSubsequence(sigA: string, sigB: string): boolean {
  if (sigA === sigB) return false;
  const a = sigA.split(",");
  const b = sigB.split(",");
  if (a.length === b.length) return false;
  const [sub, sup] = a.length < b.length ? [a, b] : [b, a];
  return isOrderedSubsequence(sub, sup);
}
