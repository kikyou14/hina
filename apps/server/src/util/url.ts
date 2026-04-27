import dns from "node:dns/promises";
import http, { type RequestOptions } from "node:http";
import https from "node:https";
import { type LookupFunction, isIP } from "node:net";

import { isPublicIp } from "./ip";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const pinnedHttpAgent = new http.Agent({ keepAlive: false });
const pinnedHttpsAgent = new https.Agent({ keepAlive: false });
const unpinnedHttpAgent = new http.Agent({ keepAlive: true });
const unpinnedHttpsAgent = new https.Agent({ keepAlive: true });

export type ResolvedHostAddr = { address: string; family: 4 | 6 };

function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function normalizeHost(host: string): string {
  const h = unbracket(host).toLowerCase();
  return h.length > 1 && h.endsWith(".") ? h.slice(0, -1) : h;
}

function isLocalhostName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

export function parseHttpUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  return parsed;
}

export function isPublicHttpUrl(raw: string): boolean {
  const parsed = parseHttpUrl(raw);
  if (!parsed) return false;
  const host = normalizeHost(parsed.hostname);
  if (isLocalhostName(host)) return false;
  return isIP(host) === 0 ? true : isPublicIp(host);
}

export type UnsafeTargetReason =
  | "invalid_url"
  | "private_host"
  | "dns_failed"
  | "no_addresses"
  | "private_address";

export type PublicHttpTarget =
  | { ok: true; url: URL; addrs: readonly ResolvedHostAddr[] }
  | { ok: false; reason: UnsafeTargetReason };

export async function ensurePublicHttpTarget(
  raw: string,
  signal?: AbortSignal | null,
): Promise<PublicHttpTarget> {
  if (signal?.aborted) return { ok: false, reason: "dns_failed" };

  const parsed = parseHttpUrl(raw);
  if (!parsed) return { ok: false, reason: "invalid_url" };

  const host = normalizeHost(parsed.hostname);
  if (isLocalhostName(host)) return { ok: false, reason: "private_host" };

  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    if (!isPublicIp(host)) return { ok: false, reason: "private_address" };
    return {
      ok: true,
      url: parsed,
      addrs: [{ address: host, family: literalFamily === 6 ? 6 : 4 }],
    };
  }

  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookupWithSignal(host, signal ?? null);
  } catch {
    return { ok: false, reason: "dns_failed" };
  }
  if (addrs.length === 0) return { ok: false, reason: "no_addresses" };
  const resolved: ResolvedHostAddr[] = [];
  for (const a of addrs) {
    if (!isPublicIp(a.address)) return { ok: false, reason: "private_address" };
    if (a.family !== 4 && a.family !== 6) return { ok: false, reason: "dns_failed" };
    resolved.push({ address: a.address, family: a.family });
  }
  return { ok: true, url: parsed, addrs: resolved };
}

function lookupWithSignal(
  host: string,
  signal: AbortSignal | null,
): Promise<Array<{ address: string; family: number }>> {
  const pending = dns.lookup(host, { all: true, verbatim: true });
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export type FetchPublicFailReason =
  | UnsafeTargetReason
  | "too_many_redirects"
  | "missing_location"
  | "redirect_invalid_url";

export type FetchPublicResult =
  | { ok: true; response: Response }
  | { ok: false; reason: FetchPublicFailReason };

/**
 * Bodies we accept on the public/admin fetch helpers. This is the documented
 * supported subset of `BodyInit`: `FormData` is excluded because we do not
 * implement multipart serialization. Callers using anything else should
 * serialize to one of these shapes themselves.
 */
export type FetchPublicBody =
  | string
  | BufferSource
  | URLSearchParams
  | Blob
  | ReadableStream<Uint8Array>;

export type FetchPublicInit = {
  method?: string;
  headers?: HeadersInit;
  body?: FetchPublicBody | null;
  signal?: AbortSignal | null;
  bodyBoundHeaders?: readonly string[];
};

type FetchExecutorInit = {
  method?: string;
  headers?: HeadersInit;
  body?: FetchPublicBody | null;
  signal?: AbortSignal | null;
  redirect?: RequestRedirect;
};

function isSameFetchTarget(a: URL, b: URL): boolean {
  if (a.host !== b.host) return false;
  if (a.protocol === b.protocol) return true;
  return a.protocol === "http:" && b.protocol === "https:";
}

export function classifyFetchPublicFailure(reason: FetchPublicFailReason): "fatal" | "retryable" {
  switch (reason) {
    case "invalid_url":
    case "private_host":
    case "private_address":
      return "fatal";
    default:
      return "retryable";
  }
}

export function ensureHttpTarget(raw: string): PublicHttpTarget {
  const parsed = parseHttpUrl(raw);
  if (!parsed) return { ok: false, reason: "invalid_url" };
  return { ok: true, url: parsed, addrs: [] };
}

type HttpTargetCheck = (raw: string, signal: AbortSignal | null) => Promise<PublicHttpTarget>;

type FetchExecutor = (
  url: URL,
  init: FetchExecutorInit,
  addrs: readonly ResolvedHostAddr[],
) => Promise<Response>;

let fetchExecutor: FetchExecutor = pinnedHttpFetch;

export function __setFetchExecutorForTests(impl: FetchExecutor | null): void {
  fetchExecutor = impl ?? pinnedHttpFetch;
}

export function __pinnedHttpFetchForTests(
  url: URL,
  init: FetchExecutorInit,
  addrs: readonly ResolvedHostAddr[],
): Promise<Response> {
  return pinnedHttpFetch(url, init, addrs);
}

export async function fetchPublicHttpTarget(
  raw: string,
  init: FetchPublicInit = {},
): Promise<FetchPublicResult> {
  return runFetchLoop(raw, init, ensurePublicHttpTarget);
}

export async function fetchHttpTarget(
  raw: string,
  init: FetchPublicInit = {},
): Promise<FetchPublicResult> {
  return runFetchLoop(raw, init, (r) => Promise.resolve(ensureHttpTarget(r)));
}

async function runFetchLoop(
  raw: string,
  init: FetchPublicInit,
  check: HttpTargetCheck,
): Promise<FetchPublicResult> {
  const { bodyBoundHeaders: extraBodyBound, ...baseInit } = init;
  const bodyBound = new Set<string>(["content-type", "content-length"]);
  if (extraBodyBound) for (const h of extraBodyBound) bodyBound.add(h.toLowerCase());

  const signal = baseInit.signal ?? null;
  let currentUrl = raw;
  let method = (baseInit.method ?? "GET").toUpperCase();
  let body: FetchPublicBody | null = baseInit.body ?? null;
  let headers: Headers | undefined =
    baseInit.headers !== undefined ? new Headers(baseInit.headers) : undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const target = await check(currentUrl, signal);
    if (!target.ok) {
      if (hop > 0 && target.reason === "invalid_url") {
        return { ok: false, reason: "redirect_invalid_url" };
      }
      return target;
    }

    const resp = await fetchExecutor(
      target.url,
      {
        ...baseInit,
        method,
        body,
        headers,
        signal,
        redirect: "manual",
      },
      target.addrs,
    );

    if (!REDIRECT_STATUSES.has(resp.status)) return { ok: true, response: resp };

    const loc = resp.headers.get("location");
    await drainBody(resp);
    if (hop >= MAX_REDIRECTS) return { ok: false, reason: "too_many_redirects" };
    if (!loc) return { ok: false, reason: "missing_location" };

    const nextUrl = new URL(loc, target.url);
    let bodyDropped = false;
    if (resp.status === 303) {
      if (method !== "GET" && method !== "HEAD") {
        method = "GET";
        body = null;
        bodyDropped = true;
      }
    } else if (resp.status === 301 || resp.status === 302) {
      if (method === "POST") {
        method = "GET";
        body = null;
        bodyDropped = true;
      }
    }

    if (!isSameFetchTarget(target.url, nextUrl)) {
      headers = undefined;
    } else if (bodyDropped && headers) {
      const names: string[] = [];
      headers.forEach((_v, name) => names.push(name));
      for (const name of names) {
        if (bodyBound.has(name.toLowerCase())) headers.delete(name);
      }
    }
    currentUrl = nextUrl.toString();
  }
  return { ok: false, reason: "too_many_redirects" };
}

async function drainBody(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // Best-effort cleanup.
  }
}

async function pinnedHttpFetch(
  targetUrl: URL,
  init: FetchExecutorInit,
  addrs: readonly ResolvedHostAddr[],
): Promise<Response> {
  const isHttps = targetUrl.protocol === "https:";
  const lib = isHttps ? https : http;
  const pinned = addrs.length > 0;
  const agent = isHttps
    ? pinned
      ? pinnedHttpsAgent
      : unpinnedHttpsAgent
    : pinned
      ? pinnedHttpAgent
      : unpinnedHttpAgent;
  const method = (init.method ?? "GET").toUpperCase();

  const reqHeaders: Record<string, string> = {};
  if (init.headers !== undefined) {
    new Headers(init.headers).forEach((v, k) => {
      reqHeaders[k] = v;
    });
  }

  const port = targetUrl.port !== "" ? Number(targetUrl.port) : isHttps ? 443 : 80;

  const reqOptions: RequestOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port,
    path: `${targetUrl.pathname}${targetUrl.search}`,
    method,
    headers: reqHeaders,
    agent,
  };
  if (pinned) reqOptions.lookup = makePinnedLookup(addrs);

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let responseReceived = false;
    const settleReject = (e: unknown): void => {
      if (settled) return;
      settled = true;
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const settleResolve = (r: Response): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const req = lib.request(reqOptions, (res) => {
      responseReceived = true;
      const status = res.statusCode ?? 0;
      const respHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) respHeaders.append(k, item);
        } else if (typeof v === "string") {
          respHeaders.set(k, v);
        }
      }

      const allowBody = !NULL_BODY_STATUSES.has(status) && method !== "HEAD";
      let body: ReadableStream<Uint8Array> | null = null;
      if (allowBody) {
        body = makeResponseStream(res);
      } else {
        res.resume();
      }

      settleResolve(
        new Response(body, {
          status,
          statusText: res.statusMessage ?? "",
          headers: respHeaders,
        }),
      );
    });

    req.on("error", settleReject);
    req.on("close", () => {
      if (!responseReceived) {
        settleReject(new Error("connection closed before response"));
      }
    });

    const signal = init.signal ?? null;
    if (signal) {
      const onAbort = (): void => {
        const reason = signal.reason ?? new Error("aborted");
        const err = reason instanceof Error ? reason : new Error(String(reason));
        settleReject(err);
        req.destroy(err);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      req.on("close", () => signal.removeEventListener("abort", onAbort));
    }

    writeBody(req, init.body ?? null).catch(settleReject);
  });
}

function makeResponseStream(res: http.IncomingMessage): ReadableStream<Uint8Array> {
  let total = 0;
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer | string): void => {
        if (closed) return;
        const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          closed = true;
          try {
            controller.error(new Error(`response body exceeds ${MAX_RESPONSE_BYTES} bytes`));
          } catch {
            // controller may already be closed via cancel()
          }
          res.destroy();
          return;
        }
        const copy = new Uint8Array(buf.byteLength);
        copy.set(buf);
        try {
          controller.enqueue(copy);
        } catch {
          // controller closed (consumer canceled): nothing to do.
        }
      };
      res.on("data", onData);
      res.on("end", () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already errored / canceled
        }
      });
      res.on("error", (e) => {
        if (closed) return;
        closed = true;
        try {
          controller.error(e);
        } catch {
          // already errored / canceled
        }
      });
    },
    cancel() {
      closed = true;
      res.destroy();
    },
  });
}

function makePinnedLookup(addrs: readonly ResolvedHostAddr[]): LookupFunction {
  return ((_hostname, options, callback) => {
    let wantAll = false;
    let familyFilter: 0 | 4 | 6 = 0;
    if (typeof options === "object" && options !== null) {
      const o = options as { all?: boolean; family?: number };
      wantAll = o.all === true;
      if (o.family === 4 || o.family === 6) familyFilter = o.family;
    } else if (options === 4 || options === 6) {
      familyFilter = options;
    }

    const matching = familyFilter === 0 ? addrs : addrs.filter((a) => a.family === familyFilter);
    if (matching.length === 0) {
      const err = new Error(
        `no pinned addresses match family=${familyFilter || "any"}`,
      ) as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      // Both overloads expect an Error first; the value args are ignored.
      (callback as unknown as (e: NodeJS.ErrnoException) => void)(err);
      return;
    }

    if (wantAll) {
      const cb = callback as unknown as (
        err: NodeJS.ErrnoException | null,
        results: Array<{ address: string; family: number }>,
      ) => void;
      // Copy out so the caller can't mutate our pinned set.
      cb(
        null,
        matching.map((a) => ({ address: a.address, family: a.family })),
      );
    } else {
      const first = matching[0]!;
      callback(null, first.address, first.family);
    }
  }) as LookupFunction;
}

export function __makePinnedLookupForTests(addrs: readonly ResolvedHostAddr[]): LookupFunction {
  return makePinnedLookup(addrs);
}

async function writeBody(req: http.ClientRequest, body: FetchPublicBody | null): Promise<void> {
  if (body === null) {
    req.end();
    return;
  }
  if (typeof body === "string") {
    req.end(body);
    return;
  }
  if (body instanceof URLSearchParams) {
    req.end(body.toString());
    return;
  }
  if (body instanceof Blob) {
    const ab = await body.arrayBuffer();
    req.end(Buffer.from(ab));
    return;
  }
  if (body instanceof ArrayBuffer) {
    req.end(Buffer.from(body));
    return;
  }
  if (ArrayBuffer.isView(body)) {
    // Covers Uint8Array, DataView, every TypedArray, and Buffer.
    req.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    return;
  }
  // Must be a ReadableStream — the FetchPublicBody union has no other arm.
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) req.write(value);
    }
    req.end();
  } finally {
    reader.releaseLock();
  }
}
