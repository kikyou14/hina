import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { agent } from "../db/schema";

export type GeoResult = {
  country: string;
  countryCode: string;
  source: string;
};

export type CacheEntry = GeoResult & { ts: number };

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

type Bucket = {
  tokens: number;
  lastMs: number;
  ratePerMs: number;
  max: number;
};

function createBucket(perMinute: number, nowMs: () => number): Bucket {
  return {
    tokens: perMinute,
    lastMs: nowMs(),
    ratePerMs: perMinute / 60_000,
    max: perMinute,
  };
}

function tryConsume(b: Bucket, nowMs: () => number): boolean {
  const now = nowMs();
  b.tokens = Math.min(b.max, b.tokens + (now - b.lastMs) * b.ratePerMs);
  b.lastMs = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return true;
  }
  return false;
}

export type GeoLookup = {
  lookupGeo: (ip: string) => Promise<GeoResult | null>;
  resolveAgentGeo: (db: DbClient, agentId: string, ip: string) => Promise<GeoResult | null>;
  clearAgentGeoState: (agentId: string) => void;
};

export type GeoLookupOptions = {
  nowMs?: () => number;
  fetchFn?: typeof fetch;
  geoCache?: Map<string, CacheEntry>;
  agentLastIp?: Map<string, string>;
};

export function createGeoLookup(options: GeoLookupOptions = {}): GeoLookup {
  const nowMs = options.nowMs ?? Date.now;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const geoCache = options.geoCache ?? new Map<string, CacheEntry>();
  const agentLastIp = options.agentLastIp ?? new Map<string, string>();

  let lastCacheCleanupAtMs = 0;

  function purgeExpiredEntries(now: number) {
    for (const [ip, entry] of geoCache) {
      if (now - entry.ts >= CACHE_TTL_MS) geoCache.delete(ip);
    }
  }

  function maybePurgeExpiredEntries(now: number) {
    if (now - lastCacheCleanupAtMs < CLEANUP_INTERVAL_MS) return;
    purgeExpiredEntries(now);
    lastCacheCleanupAtMs = now;
  }

  const ipinfoBucket = createBucket(80, nowMs);
  const geojsBucket = createBucket(60, nowMs);

  async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function tryIpinfo(ip: string): Promise<GeoResult | null> {
    if (!tryConsume(ipinfoBucket, nowMs)) return null;
    try {
      const res = await fetchWithTimeout(
        `https://ipinfo.io/${encodeURIComponent(ip)}/json`,
        FETCH_TIMEOUT_MS,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const code = typeof data["country"] === "string" ? data["country"].trim() : "";
      const cc = code.toUpperCase();
      if (!/^[A-Z]{2}$/.test(cc)) return null;
      return {
        countryCode: cc,
        country: countryName(cc),
        source: "ipinfo",
      };
    } catch {
      return null;
    }
  }

  async function tryGeoJs(ip: string): Promise<GeoResult | null> {
    if (!tryConsume(geojsBucket, nowMs)) return null;
    try {
      const res = await fetchWithTimeout(
        `https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ip)}.json`,
        FETCH_TIMEOUT_MS,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as Record<string, unknown>;
      const cc =
        typeof data["country_code"] === "string" ? data["country_code"].trim().toUpperCase() : "";
      if (!/^[A-Z]{2}$/.test(cc)) return null;
      const name =
        typeof data["country"] === "string" && data["country"].trim()
          ? data["country"].trim()
          : countryName(cc);
      return {
        countryCode: cc,
        country: name,
        source: "geojs",
      };
    } catch {
      return null;
    }
  }

  async function lookupGeo(ip: string): Promise<GeoResult | null> {
    const now = nowMs();
    maybePurgeExpiredEntries(now);

    const cached = geoCache.get(ip);
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      return {
        country: cached.country,
        countryCode: cached.countryCode,
        source: cached.source,
      };
    }
    if (cached) geoCache.delete(ip);

    const result = (await tryIpinfo(ip)) ?? (await tryGeoJs(ip));
    if (result) {
      geoCache.set(ip, { ...result, ts: nowMs() });
    }
    return result;
  }

  async function resolveAgentGeo(
    db: DbClient,
    agentId: string,
    ip: string,
  ): Promise<GeoResult | null> {
    if (agentLastIp.get(agentId) === ip) return null;
    agentLastIp.set(agentId, ip);

    const geo = await lookupGeo(ip);
    if (!geo) {
      if (agentLastIp.get(agentId) === ip) {
        agentLastIp.delete(agentId);
      }
      return null;
    }
    if (agentLastIp.get(agentId) !== ip) return null;

    await db
      .update(agent)
      .set({
        geoCountryCode: geo.countryCode,
        geoCountry: geo.country,
        geoSource: geo.source,
        updatedAtMs: nowMs(),
      })
      .where(eq(agent.id, agentId));

    if (agentLastIp.get(agentId) !== ip) return null;
    return geo;
  }

  function clearAgentGeoState(agentId: string): void {
    agentLastIp.delete(agentId);
  }

  return { lookupGeo, resolveAgentGeo, clearAgentGeoState };
}
