import { describe, expect, test } from "bun:test";

import type { DbClient } from "../db/client";
import { type CacheEntry, createGeoLookup } from "./lookup";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function createGeoResponse(countryCode: string): Response {
  return new Response(JSON.stringify({ country: countryCode }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createEmptyGeoResponse(): Response {
  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createDbStub() {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    update() {
      return {
        set(values: Record<string, unknown>) {
          return {
            async where() {
              writes.push(values);
            },
          };
        },
      };
    },
  } as unknown as DbClient;

  return { db, writes };
}

function extractIp(url: string): string {
  const { pathname } = new URL(url);
  const segments = pathname.split("/").filter(Boolean);
  const last = segments.at(-1);
  if (!last) throw new Error(`Unexpected geo URL: ${url}`);
  if (last === "json") {
    const ip = segments.at(-2);
    if (!ip) throw new Error(`Unexpected geo URL: ${url}`);
    return decodeURIComponent(ip);
  }
  if (last.endsWith(".json")) {
    return decodeURIComponent(last.slice(0, -".json".length));
  }
  throw new Error(`Unexpected geo URL: ${url}`);
}

describe("geo lookup cache", () => {
  test("cleans cache on demand without global patching", async () => {
    class TrackingMap extends Map<string, CacheEntry> {
      public deletedKeys: string[] = [];

      delete(key: string): boolean {
        this.deletedKeys.push(key);
        return super.delete(key);
      }
    }

    let now = 4_100_000_000_000;
    const nowMs = () => now;

    let fetchCalls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      fetchCalls += 1;
      const url = String(input);
      if (url.includes("8.8.8.8")) return createGeoResponse("US");
      return createGeoResponse("CA");
    }) as unknown as typeof fetch;

    const geoCache = new TrackingMap();
    const geo = createGeoLookup({ nowMs, fetchFn, geoCache });

    const first = await geo.lookupGeo("8.8.8.8");
    const second = await geo.lookupGeo("8.8.8.8");
    expect(first).toEqual({
      country: "United States",
      countryCode: "US",
      source: "ipinfo",
    });
    expect(second).toEqual(first);
    expect(fetchCalls).toBe(1);

    now += CACHE_TTL_MS + CLEANUP_INTERVAL_MS + 1;
    await geo.lookupGeo("1.1.1.1");
    expect(geoCache.deletedKeys).toContain("8.8.8.8");
  });

  test("does not share cache between instances", async () => {
    const now = 4_100_000_000_000;
    const nowMs = () => now;

    let fetchCalls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      fetchCalls += 1;
      const url = String(input);
      if (url.includes("8.8.8.8")) return createGeoResponse("US");
      return createGeoResponse("CA");
    }) as unknown as typeof fetch;

    const a = createGeoLookup({ nowMs, fetchFn });
    const b = createGeoLookup({ nowMs, fetchFn });

    await a.lookupGeo("8.8.8.8");
    await b.lookupGeo("8.8.8.8");
    expect(fetchCalls).toBe(2);

    await a.lookupGeo("8.8.8.8");
    await b.lookupGeo("8.8.8.8");
    expect(fetchCalls).toBe(2);
  });

  test("deduplicates in-flight agent lookups and retries after a failed lookup", async () => {
    const { db, writes } = createDbStub();
    const pending = new Map<string, Array<ReturnType<typeof createDeferred<Response>>>>();
    let fetchCalls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      fetchCalls += 1;
      const queue = pending.get(extractIp(String(input)));
      const next = queue?.shift();
      if (!next) throw new Error(`Unexpected fetch for ${String(input)}`);
      return await next.promise;
    }) as unknown as typeof fetch;

    const geo = createGeoLookup({ fetchFn });
    const ip = "8.8.8.8";
    const firstIpinfo = createDeferred<Response>();
    const firstGeoJs = createDeferred<Response>();
    const retryIpinfo = createDeferred<Response>();
    pending.set(ip, [firstIpinfo, firstGeoJs, retryIpinfo]);

    const first = geo.resolveAgentGeo(db, "agent-1", ip);
    const second = await geo.resolveAgentGeo(db, "agent-1", ip);
    expect(second).toBeNull();

    firstIpinfo.resolve(createEmptyGeoResponse());
    firstGeoJs.resolve(createEmptyGeoResponse());

    expect(await first).toBeNull();
    expect(fetchCalls).toBe(2);
    expect(writes).toHaveLength(0);

    const retry = geo.resolveAgentGeo(db, "agent-1", ip);
    retryIpinfo.resolve(createGeoResponse("US"));

    expect(await retry).toEqual({
      country: "United States",
      countryCode: "US",
      source: "ipinfo",
    });
    expect(fetchCalls).toBe(3);
    expect(writes).toHaveLength(1);
  });

  test("drops stale in-flight lookup results after reconnect switches to a new ip", async () => {
    const { db, writes } = createDbStub();
    const pending = new Map<string, Array<ReturnType<typeof createDeferred<Response>>>>();
    const fetchFn = (async (input: string | URL | Request) => {
      const queue = pending.get(extractIp(String(input)));
      const next = queue?.shift();
      if (!next) throw new Error(`Unexpected fetch for ${String(input)}`);
      return await next.promise;
    }) as unknown as typeof fetch;

    const geo = createGeoLookup({ fetchFn });
    const oldIp = "8.8.8.8";
    const newIp = "1.1.1.1";
    const oldLookup = createDeferred<Response>();
    const newLookup = createDeferred<Response>();
    pending.set(oldIp, [oldLookup]);
    pending.set(newIp, [newLookup]);

    const stale = geo.resolveAgentGeo(db, "agent-1", oldIp);
    geo.clearAgentGeoState("agent-1");
    const fresh = geo.resolveAgentGeo(db, "agent-1", newIp);

    newLookup.resolve(createGeoResponse("CA"));
    expect(await fresh).toEqual({
      country: "Canada",
      countryCode: "CA",
      source: "ipinfo",
    });
    expect(writes).toHaveLength(1);

    oldLookup.resolve(createGeoResponse("US"));
    expect(await stale).toBeNull();
    expect(writes).toHaveLength(1);
  });
});
