import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import {
  __makePinnedLookupForTests,
  __pinnedHttpFetchForTests,
  __setFetchExecutorForTests,
  classifyFetchPublicFailure,
  ensureHttpTarget,
  ensurePublicHttpTarget,
  fetchHttpTarget,
  fetchPublicHttpTarget,
  isPublicHttpUrl,
  parseHttpUrl,
} from "./url";

beforeAll(() => {
  __setFetchExecutorForTests((url, init) => globalThis.fetch(url, init));
});
afterAll(() => {
  __setFetchExecutorForTests(null);
});

describe("parseHttpUrl", () => {
  test("accepts http and https", () => {
    expect(parseHttpUrl("http://example.com/hook")).not.toBeNull();
    expect(parseHttpUrl("https://example.com/hook")).not.toBeNull();
  });

  test("rejects non-http schemes", () => {
    expect(parseHttpUrl("file:///etc/passwd")).toBeNull();
    expect(parseHttpUrl("ftp://example.com/")).toBeNull();
    expect(parseHttpUrl("gopher://example.com/")).toBeNull();
    expect(parseHttpUrl("javascript:alert(1)")).toBeNull();
  });

  test("rejects malformed inputs", () => {
    expect(parseHttpUrl("not-a-url")).toBeNull();
    expect(parseHttpUrl("")).toBeNull();
  });
});

describe("isPublicHttpUrl", () => {
  test("accepts hostnames and public IP literals", () => {
    expect(isPublicHttpUrl("https://example.com/hook")).toBe(true);
    expect(isPublicHttpUrl("https://api.example.com:8443/h")).toBe(true);
    expect(isPublicHttpUrl("http://8.8.8.8/")).toBe(true);
    expect(isPublicHttpUrl("http://[2606:4700:4700::1111]/")).toBe(true);
  });

  test("rejects non-http schemes", () => {
    expect(isPublicHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isPublicHttpUrl("ftp://example.com/")).toBe(false);
  });

  test("rejects localhost variants", () => {
    expect(isPublicHttpUrl("http://localhost/")).toBe(false);
    expect(isPublicHttpUrl("http://LOCALHOST:8080/")).toBe(false);
    expect(isPublicHttpUrl("http://admin.localhost/")).toBe(false);
    // FQDN absolute form (trailing dot) must not bypass the name check.
    expect(isPublicHttpUrl("http://localhost./")).toBe(false);
    expect(isPublicHttpUrl("http://LOCALHOST./hook")).toBe(false);
    expect(isPublicHttpUrl("http://admin.localhost./")).toBe(false);
  });

  test("rejects IPv4 private/reserved literals", () => {
    expect(isPublicHttpUrl("http://127.0.0.1/")).toBe(false);
    expect(isPublicHttpUrl("http://10.0.0.1/")).toBe(false);
    expect(isPublicHttpUrl("http://192.168.1.1/")).toBe(false);
    expect(isPublicHttpUrl("http://172.16.0.1/")).toBe(false);
    expect(isPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isPublicHttpUrl("http://100.64.0.1/")).toBe(false);
    expect(isPublicHttpUrl("http://0.0.0.0/")).toBe(false);
    expect(isPublicHttpUrl("http://198.18.0.1/")).toBe(false); // RFC 2544 benchmarking
    expect(isPublicHttpUrl("http://192.0.0.1/")).toBe(false); // IETF Protocol Assignments
  });

  test("rejects IPv6 private/reserved literals", () => {
    expect(isPublicHttpUrl("http://[::1]/")).toBe(false);
    expect(isPublicHttpUrl("http://[fd00::1]/")).toBe(false);
    expect(isPublicHttpUrl("http://[fe80::1]/")).toBe(false);
    expect(isPublicHttpUrl("http://[::ffff:127.0.0.1]/")).toBe(false);
    expect(isPublicHttpUrl("http://[::ffff:192.168.1.1]/")).toBe(false);
    expect(isPublicHttpUrl("http://[2001:db8::1]/")).toBe(false); // RFC 3849 documentation
  });

  test("rejects malformed input", () => {
    expect(isPublicHttpUrl("")).toBe(false);
    expect(isPublicHttpUrl("not-a-url")).toBe(false);
  });
});

describe("ensurePublicHttpTarget", () => {
  test("passes literal public IPs without touching DNS", async () => {
    const r = await ensurePublicHttpTarget("https://8.8.8.8/hook");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url.hostname).toBe("8.8.8.8");
      // For literal IPs the resolved set is just the literal — no DNS query
      // happened, so there's nothing else to pin to.
      expect(r.addrs).toEqual([{ address: "8.8.8.8", family: 4 }]);
    }
  });

  test("returns family 6 for literal IPv6 public addrs", async () => {
    const r = await ensurePublicHttpTarget("https://[2606:4700:4700::1111]/");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.addrs).toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
  });

  test("rejects literal private IPs", async () => {
    expect(await ensurePublicHttpTarget("http://127.0.0.1/")).toEqual({
      ok: false,
      reason: "private_address",
    });
    expect(await ensurePublicHttpTarget("http://169.254.169.254/")).toEqual({
      ok: false,
      reason: "private_address",
    });
    expect(await ensurePublicHttpTarget("http://[::1]/")).toEqual({
      ok: false,
      reason: "private_address",
    });
    expect(await ensurePublicHttpTarget("http://[fd00::1]/")).toEqual({
      ok: false,
      reason: "private_address",
    });
  });

  test("rejects localhost variants", async () => {
    expect(await ensurePublicHttpTarget("http://localhost/")).toEqual({
      ok: false,
      reason: "private_host",
    });
    expect(await ensurePublicHttpTarget("http://admin.localhost/")).toEqual({
      ok: false,
      reason: "private_host",
    });
    // Trailing dot must be classified as `private_host` (fatal), not
    // left to DNS where resolver quirks can surface it as dns_failed.
    expect(await ensurePublicHttpTarget("http://localhost./")).toEqual({
      ok: false,
      reason: "private_host",
    });
    expect(await ensurePublicHttpTarget("http://admin.localhost./")).toEqual({
      ok: false,
      reason: "private_host",
    });
  });

  test("rejects non-http schemes and malformed input", async () => {
    expect(await ensurePublicHttpTarget("file:///etc/passwd")).toEqual({
      ok: false,
      reason: "invalid_url",
    });
    expect(await ensurePublicHttpTarget("not-a-url")).toEqual({
      ok: false,
      reason: "invalid_url",
    });
  });

  test("rejects newly-covered special-use literals", async () => {
    expect(await ensurePublicHttpTarget("http://198.18.0.1/")).toEqual({
      ok: false,
      reason: "private_address",
    });
    expect(await ensurePublicHttpTarget("http://[2001:db8::1]/")).toEqual({
      ok: false,
      reason: "private_address",
    });
  });

  test("short-circuits when the caller's signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await ensurePublicHttpTarget("https://example.com/hook", ctrl.signal)).toEqual({
      ok: false,
      reason: "dns_failed",
    });
  });
});

describe("ensureHttpTarget", () => {
  test("accepts private and loopback literals (admin-trusted channel)", () => {
    expect(ensureHttpTarget("http://192.168.1.1/")).toEqual({
      ok: true,
      url: new URL("http://192.168.1.1/"),
      addrs: [],
    });
    expect(ensureHttpTarget("http://10.0.0.1/push")).toEqual({
      ok: true,
      url: new URL("http://10.0.0.1/push"),
      addrs: [],
    });
    expect(ensureHttpTarget("http://localhost:8080/")).toEqual({
      ok: true,
      url: new URL("http://localhost:8080/"),
      addrs: [],
    });
    expect(ensureHttpTarget("http://[fd00::1]/")).toEqual({
      ok: true,
      url: new URL("http://[fd00::1]/"),
      addrs: [],
    });
  });

  test("still rejects non-http schemes and malformed input", () => {
    expect(ensureHttpTarget("file:///etc/passwd")).toEqual({
      ok: false,
      reason: "invalid_url",
    });
    expect(ensureHttpTarget("not-a-url")).toEqual({ ok: false, reason: "invalid_url" });
  });
});

describe("classifyFetchPublicFailure", () => {
  test("marks config-level rejections as fatal", () => {
    expect(classifyFetchPublicFailure("invalid_url")).toBe("fatal");
    expect(classifyFetchPublicFailure("private_host")).toBe("fatal");
    expect(classifyFetchPublicFailure("private_address")).toBe("fatal");
  });

  test("marks transient / response-level failures as retryable", () => {
    expect(classifyFetchPublicFailure("dns_failed")).toBe("retryable");
    expect(classifyFetchPublicFailure("no_addresses")).toBe("retryable");
    expect(classifyFetchPublicFailure("too_many_redirects")).toBe("retryable");
    expect(classifyFetchPublicFailure("missing_location")).toBe("retryable");
    // Upstream redirected us to a bad Location — do not dead-letter.
    expect(classifyFetchPublicFailure("redirect_invalid_url")).toBe("retryable");
  });
});

describe("fetchPublicHttpTarget redirects", () => {
  type Captured = { url: string; method: string; headers: Record<string, string> };
  const originalFetch = globalThis.fetch;

  function installFetch(respond: (call: number, url: URL) => Response): { captured: Captured[] } {
    const captured: Captured[] = [];
    let call = 0;
    globalThis.fetch = (async (input, init) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const headerMap: Record<string, string> = {};
      if (init?.headers) {
        new Headers(init.headers).forEach((v, k) => {
          headerMap[k] = v;
        });
      }
      captured.push({
        url: urlStr,
        method: (init?.method ?? "GET").toUpperCase(),
        headers: headerMap,
      });
      return respond(++call, new URL(urlStr));
    }) as typeof fetch;
    return { captured };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("re-validates the next hop and rejects redirects to private IPs", async () => {
    const { captured } = installFetch((call) => {
      if (call === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      return new Response(null, { status: 200 });
    });

    const result = await fetchPublicHttpTarget("http://8.8.8.8/hook", {
      method: "POST",
      headers: { "x-api-key": "s3cret" },
      body: "payload",
    });

    expect(result).toEqual({ ok: false, reason: "private_address" });
    expect(captured).toHaveLength(1); // second hop never issued
  });

  test("drops caller headers on cross-origin redirect", async () => {
    const { captured } = installFetch((call) => {
      if (call === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: "http://1.1.1.1/next" },
        });
      }
      return new Response(null, { status: 200 });
    });

    const result = await fetchPublicHttpTarget("http://8.8.8.8/hook", {
      method: "POST",
      headers: {
        authorization: "Bearer topsecret",
        "x-api-key": "s3cret",
        "x-hina-signature": "sha256=deadbeef",
        "content-type": "application/json",
      },
      body: "payload",
    });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.headers["authorization"]).toBe("Bearer topsecret");
    expect(captured[0]!.headers["x-api-key"]).toBe("s3cret");
    expect(captured[0]!.headers["x-hina-signature"]).toBe("sha256=deadbeef");
    expect(captured[1]!.headers["authorization"]).toBeUndefined();
    expect(captured[1]!.headers["x-api-key"]).toBeUndefined();
    expect(captured[1]!.headers["x-hina-signature"]).toBeUndefined();
    // content-type is caller-provided here, so it is also dropped on the hop
    expect(captured[1]!.headers["content-type"]).toBeUndefined();
  });

  test("preserves caller headers on same-origin redirect", async () => {
    const { captured } = installFetch((call) => {
      if (call === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: "http://8.8.8.8/other" },
        });
      }
      return new Response(null, { status: 200 });
    });

    const result = await fetchPublicHttpTarget("http://8.8.8.8/hook", {
      method: "POST",
      headers: { "x-api-key": "s3cret" },
      body: "payload",
    });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.headers["x-api-key"]).toBe("s3cret");
    expect(captured[1]!.headers["x-api-key"]).toBe("s3cret");
    expect(captured[1]!.url).toBe("http://8.8.8.8/other");
    // 307 preserves method + body
    expect(captured[1]!.method).toBe("POST");
  });

  test("demotes POST to GET and clears body on 303", async () => {
    const { captured } = installFetch((call) => {
      if (call === 1) {
        return new Response(null, {
          status: 303,
          headers: { location: "http://8.8.8.8/other" },
        });
      }
      return new Response(null, { status: 200 });
    });

    await fetchPublicHttpTarget("http://8.8.8.8/hook", {
      method: "POST",
      headers: { "x-api-key": "s3cret" },
      body: "payload",
    });

    expect(captured[1]!.method).toBe("GET");
    // same-origin: header is kept; we verify the demotion only
    expect(captured[1]!.headers["x-api-key"]).toBe("s3cret");
  });

  test("demotes non-GET/HEAD to GET on 303 (PUT case)", async () => {
    const { captured } = installFetch((call) => {
      if (call === 1) {
        return new Response(null, {
          status: 303,
          headers: { location: "http://8.8.8.8/other" },
        });
      }
      return new Response(null, { status: 200 });
    });

    await fetchPublicHttpTarget("http://8.8.8.8/hook", {
      method: "PUT",
      body: "payload",
    });

    expect(captured[1]!.method).toBe("GET");
  });

  test("demotes POST to GET on 301/302 (historical exception)", async () => {
    for (const status of [301, 302] as const) {
      const { captured } = installFetch((call) => {
        if (call === 1) {
          return new Response(null, {
            status,
            headers: { location: "http://8.8.8.8/other" },
          });
        }
        return new Response(null, { status: 200 });
      });

      await fetchPublicHttpTarget("http://8.8.8.8/hook", {
        method: "POST",
        body: "payload",
      });

      expect(captured[1]!.method).toBe("GET");
    }
  });

  test("preserves PUT method and body across 301/302 redirects", async () => {
    for (const status of [301, 302] as const) {
      const { captured } = installFetch((call) => {
        if (call === 1) {
          return new Response(null, {
            status,
            headers: { location: "http://8.8.8.8/other" },
          });
        }
        return new Response(null, { status: 200 });
      });

      const result = await fetchPublicHttpTarget("http://8.8.8.8/hook", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "payload",
      });

      expect(result.ok).toBe(true);
      expect(captured[1]!.method).toBe("PUT");
    }
  });

  test("preserves caller headers on http -> https upgrade (same host)", async () => {
    const { captured } = installFetch((call) => {
      if (call === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: "https://8.8.8.8/hook" },
        });
      }
      return new Response(null, { status: 200 });
    });

    const result = await fetchPublicHttpTarget("http://8.8.8.8/hook", {
      method: "POST",
      headers: { authorization: "Bearer topsecret", "x-hina-signature": "sha256=deadbeef" },
      body: "payload",
    });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[1]!.url).toBe("https://8.8.8.8/hook");
    expect(captured[1]!.headers["authorization"]).toBe("Bearer topsecret");
    expect(captured[1]!.headers["x-hina-signature"]).toBe("sha256=deadbeef");
    expect(captured[1]!.method).toBe("POST");
  });

  test("strips content-type and content-length when body is dropped on same-host 303", async () => {
    const { captured } = installFetch((call) => {
      if (call === 1) {
        return new Response(null, {
          status: 303,
          headers: { location: "http://8.8.8.8/other" },
        });
      }
      return new Response(null, { status: 200 });
    });

    await fetchPublicHttpTarget("http://8.8.8.8/hook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "7",
        "x-api-key": "s3cret",
      },
      body: "payload",
    });

    expect(captured[1]!.method).toBe("GET");
    expect(captured[1]!.headers["content-type"]).toBeUndefined();
    expect(captured[1]!.headers["content-length"]).toBeUndefined();
    // Non-body-bound headers (auth, api keys) survive the same-host downgrade.
    expect(captured[1]!.headers["x-api-key"]).toBe("s3cret");
  });

  test("strips caller-declared body-bound headers when body is dropped", async () => {
    const { captured } = installFetch((call) => {
      if (call === 1) {
        return new Response(null, {
          status: 303,
          headers: { location: "http://8.8.8.8/other" },
        });
      }
      return new Response(null, { status: 200 });
    });

    await fetchPublicHttpTarget("http://8.8.8.8/hook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hina-signature": "sha256=deadbeef",
        "x-api-key": "s3cret",
      },
      body: "payload",
      bodyBoundHeaders: ["x-hina-signature"],
    });

    expect(captured[1]!.method).toBe("GET");
    expect(captured[1]!.headers["x-hina-signature"]).toBeUndefined();
    expect(captured[1]!.headers["content-type"]).toBeUndefined();
    expect(captured[1]!.headers["x-api-key"]).toBe("s3cret");
  });

  test("keeps body-bound headers across 307/308 (body not dropped)", async () => {
    const { captured } = installFetch((call) => {
      if (call === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: "http://8.8.8.8/other" },
        });
      }
      return new Response(null, { status: 200 });
    });

    await fetchPublicHttpTarget("http://8.8.8.8/hook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hina-signature": "sha256=deadbeef" },
      body: "payload",
      bodyBoundHeaders: ["x-hina-signature"],
    });

    expect(captured[1]!.method).toBe("POST");
    expect(captured[1]!.headers["content-type"]).toBe("application/json");
    expect(captured[1]!.headers["x-hina-signature"]).toBe("sha256=deadbeef");
  });

  test("gives up after MAX_REDIRECTS hops", async () => {
    const { captured } = installFetch(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "http://8.8.8.8/loop" },
        }),
    );

    const result = await fetchPublicHttpTarget("http://8.8.8.8/hook", { method: "GET" });
    expect(result).toEqual({ ok: false, reason: "too_many_redirects" });
    expect(captured.length).toBeGreaterThan(1);
  });

  test("fetchPublicHttpTarget rejects LAN hosts (regression guard)", async () => {
    const result = await fetchPublicHttpTarget("http://192.168.1.1/push", { method: "POST" });
    expect(result).toEqual({ ok: false, reason: "private_address" });
  });

  test("maps upstream redirect to non-http target as retryable, not fatal", async () => {
    installFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "mailto:ops@example.com" },
        }),
    );

    const result = await fetchPublicHttpTarget("http://8.8.8.8/hook", { method: "POST" });
    expect(result).toEqual({ ok: false, reason: "redirect_invalid_url" });
    // And the classifier keeps it out of the markDead path.
    if (!result.ok) expect(classifyFetchPublicFailure(result.reason)).toBe("retryable");
  });

  test("still reports fatal invalid_url when the initial URL is malformed", async () => {
    // No upstream call should happen — the first-hop check fails synchronously.
    const { captured } = installFetch(() => new Response(null, { status: 200 }));
    const result = await fetchPublicHttpTarget("javascript:alert(1)");
    expect(result).toEqual({ ok: false, reason: "invalid_url" });
    expect(captured).toHaveLength(0);
  });

  test("preserves fatal SSRF reasons on redirects to private addresses", async () => {
    installFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    );
    const result = await fetchPublicHttpTarget("http://8.8.8.8/hook", { method: "POST" });
    expect(result).toEqual({ ok: false, reason: "private_address" });
    if (!result.ok) expect(classifyFetchPublicFailure(result.reason)).toBe("fatal");
  });
});

describe("fetchHttpTarget (admin-trusted)", () => {
  type Captured = { url: string; method: string; headers: Record<string, string> };
  const originalFetch = globalThis.fetch;

  function installFetch(respond: (call: number, url: URL) => Response): { captured: Captured[] } {
    const captured: Captured[] = [];
    let call = 0;
    globalThis.fetch = (async (input, init) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const headerMap: Record<string, string> = {};
      if (init?.headers) {
        new Headers(init.headers).forEach((v, k) => {
          headerMap[k] = v;
        });
      }
      captured.push({
        url: urlStr,
        method: (init?.method ?? "GET").toUpperCase(),
        headers: headerMap,
      });
      return respond(++call, new URL(urlStr));
    }) as typeof fetch;
    return { captured };
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("reaches LAN hosts that fetchPublicHttpTarget would block", async () => {
    const { captured } = installFetch(() => new Response(null, { status: 200 }));
    const result = await fetchHttpTarget("http://192.168.1.1/push", { method: "POST" });
    expect(result.ok).toBe(true);
    expect(captured[0]!.url).toBe("http://192.168.1.1/push");
  });

  test("still strips caller headers on cross-host redirect", async () => {
    const { captured } = installFetch((call) => {
      if (call === 1) {
        return new Response(null, {
          status: 307,
          headers: { location: "http://192.168.1.2/next" },
        });
      }
      return new Response(null, { status: 200 });
    });

    await fetchHttpTarget("http://192.168.1.1/push", {
      method: "POST",
      headers: { authorization: "Bearer topsecret" },
      body: "payload",
    });

    expect(captured).toHaveLength(2);
    expect(captured[0]!.headers["authorization"]).toBe("Bearer topsecret");
    expect(captured[1]!.headers["authorization"]).toBeUndefined();
  });

  test("rejects non-http schemes", async () => {
    const result = await fetchHttpTarget("file:///etc/passwd");
    expect(result).toEqual({ ok: false, reason: "invalid_url" });
  });

  test("maps upstream redirect to non-http target as retryable", async () => {
    installFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "mailto:ops@example.com" },
        }),
    );

    const result = await fetchHttpTarget("http://192.168.1.1/push", { method: "POST" });
    expect(result).toEqual({ ok: false, reason: "redirect_invalid_url" });
    if (!result.ok) expect(classifyFetchPublicFailure(result.reason)).toBe("retryable");
  });
});

describe("DNS pinning (TOCTOU regression)", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    __setFetchExecutorForTests((url, init) => globalThis.fetch(url, init));
  });

  test("forwards the validated addrs to the network executor", async () => {
    const captured: Array<{ url: string; addrs: readonly { address: string; family: 4 | 6 }[] }> =
      [];
    __setFetchExecutorForTests(async (url, _init, addrs) => {
      captured.push({ url: url.toString(), addrs: addrs.map((a) => ({ ...a })) });
      return new Response(null, { status: 200 });
    });

    const result = await fetchPublicHttpTarget("http://8.8.8.8/hook", { method: "POST" });
    expect(result.ok).toBe(true);
    expect(captured).toEqual([
      { url: "http://8.8.8.8/hook", addrs: [{ address: "8.8.8.8", family: 4 }] },
    ]);
  });

  test("re-validates and re-pins on every redirect hop", async () => {
    const captured: Array<{ url: string; addrs: readonly { address: string; family: 4 | 6 }[] }> =
      [];
    let call = 0;
    __setFetchExecutorForTests(async (url, _init, addrs) => {
      captured.push({ url: url.toString(), addrs: addrs.map((a) => ({ ...a })) });
      call += 1;
      if (call === 1) {
        return new Response(null, { status: 307, headers: { location: "http://1.1.1.1/next" } });
      }
      return new Response(null, { status: 200 });
    });

    const result = await fetchPublicHttpTarget("http://8.8.8.8/hook", { method: "POST" });
    expect(result.ok).toBe(true);
    expect(captured).toEqual([
      { url: "http://8.8.8.8/hook", addrs: [{ address: "8.8.8.8", family: 4 }] },
      { url: "http://1.1.1.1/next", addrs: [{ address: "1.1.1.1", family: 4 }] },
    ]);
  });
});

describe("makePinnedLookup", () => {
  type LookupAllCb = (
    err: NodeJS.ErrnoException | null,
    results: Array<{ address: string; family: number }>,
  ) => void;
  type LookupOneCb = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

  function callAll(
    fn: ReturnType<typeof __makePinnedLookupForTests>,
    options: { all?: boolean; family?: number },
  ): { err: NodeJS.ErrnoException | null; results: Array<{ address: string; family: number }> } {
    let captured: {
      err: NodeJS.ErrnoException | null;
      results: Array<{ address: string; family: number }>;
    } = { err: null, results: [] };
    const cb: LookupAllCb = (err, results) => {
      captured = { err, results };
    };
    fn("ignored", options, cb as unknown as Parameters<typeof fn>[2]);
    return captured;
  }

  function callOne(
    fn: ReturnType<typeof __makePinnedLookupForTests>,
    options: { all?: boolean; family?: number },
  ): { err: NodeJS.ErrnoException | null; address: string; family: number } {
    let captured = {
      err: null as NodeJS.ErrnoException | null,
      address: "",
      family: 0,
    };
    const cb: LookupOneCb = (err, address, family) => {
      captured = { err, address, family };
    };
    fn("ignored", options, cb as Parameters<typeof fn>[2]);
    return captured;
  }

  const dual = [
    { address: "1.2.3.4", family: 4 as const },
    { address: "2606:4700::1", family: 6 as const },
  ];

  test("returns all pinned addrs when family is unconstrained", () => {
    const { err, results } = callAll(__makePinnedLookupForTests(dual), { all: true });
    expect(err).toBeNull();
    expect(results).toEqual([
      { address: "1.2.3.4", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ]);
  });

  test("filters by options.family=4 in the all-mode", () => {
    const { err, results } = callAll(__makePinnedLookupForTests(dual), { all: true, family: 4 });
    expect(err).toBeNull();
    expect(results).toEqual([{ address: "1.2.3.4", family: 4 }]);
  });

  test("filters by options.family=6 in the all-mode", () => {
    const { err, results } = callAll(__makePinnedLookupForTests(dual), { all: true, family: 6 });
    expect(err).toBeNull();
    expect(results).toEqual([{ address: "2606:4700::1", family: 6 }]);
  });

  test("returns ENOTFOUND when the family filter matches nothing", () => {
    const v4Only = [{ address: "1.2.3.4", family: 4 as const }];
    const { err } = callAll(__makePinnedLookupForTests(v4Only), { all: true, family: 6 });
    expect(err).not.toBeNull();
    expect(err?.code).toBe("ENOTFOUND");
  });

  test("first-only mode picks an address matching the family filter", () => {
    const { err, address, family } = callOne(__makePinnedLookupForTests(dual), { family: 4 });
    expect(err).toBeNull();
    expect(address).toBe("1.2.3.4");
    expect(family).toBe(4);
  });

  test("first-only mode without family uses the first pinned addr", () => {
    const { err, address, family } = callOne(__makePinnedLookupForTests(dual), {});
    expect(err).toBeNull();
    expect(address).toBe("1.2.3.4");
    expect(family).toBe(4);
  });

  test("does not leak the pinned set: mutating the result must not affect later lookups", () => {
    const lookup = __makePinnedLookupForTests(dual);
    const first = callAll(lookup, { all: true });
    first.results.push({ address: "9.9.9.9", family: 4 });
    const second = callAll(lookup, { all: true });
    expect(second.results).toEqual([
      { address: "1.2.3.4", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ]);
  });
});

describe("pinnedHttpFetch (production path)", () => {
  // Drives the actual `node:http` executor (the one that closes the SSRF
  // TOCTOU) end-to-end against a local Bun.serve, bypassing the validation
  // pipeline that would otherwise reject loopback URLs.

  test("DNS pinning forces the TCP connection onto the pinned IP, while Host header keeps the URL hostname", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => new Response(`host=${req.headers.get("host") ?? ""}`),
    });
    try {
      // The URL hostname is unresolvable — if pinning weren't in effect the
      // connect would fail with ENOTFOUND. The pinned addrs reroute the TCP
      // connection to 127.0.0.1, but the `Host` header still carries the
      // original hostname.
      const fakeHost = "totally-not-real.invalid";
      const url = new URL(`http://${fakeHost}:${server.port}/hook`);
      const resp = await __pinnedHttpFetchForTests(
        url,
        { method: "POST", body: "payload", headers: { "content-type": "text/plain" } },
        [{ address: "127.0.0.1", family: 4 }],
      );
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe(`host=${fakeHost}:${server.port}`);
    } finally {
      server.stop(true);
    }
  });

  test("round-trips an HTTP request via fetchHttpTarget end-to-end", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const body = await req.text();
        return new Response(`got ${req.method} body=${body}`, { status: 201 });
      },
    });
    try {
      __setFetchExecutorForTests(null);
      const result = await fetchHttpTarget(`http://127.0.0.1:${server.port}/hook`, {
        method: "POST",
        body: "payload",
        headers: { "content-type": "text/plain" },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.response.status).toBe(201);
        expect(await result.response.text()).toBe("got POST body=payload");
      }
    } finally {
      server.stop(true);
      __setFetchExecutorForTests((url, init) => globalThis.fetch(url, init));
    }
  });

  test("propagates AbortSignal to the in-flight request", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        await new Promise(() => {}); // stall forever
        return new Response("never");
      },
    });
    try {
      __setFetchExecutorForTests(null);
      const ctrl = new AbortController();
      const promise = fetchHttpTarget(`http://127.0.0.1:${server.port}/`, {
        method: "GET",
        signal: ctrl.signal,
      });
      setTimeout(() => ctrl.abort(new Error("client timeout")), 25);
      await expect(promise).rejects.toThrow();
    } finally {
      server.stop(true);
      __setFetchExecutorForTests((url, init) => globalThis.fetch(url, init));
    }
  });

  test("public path does NOT reuse a keep-alive socket from the admin-trusted path", async () => {
    // Same hostname:port for both modes. The admin-trusted path uses a
    // keep-alive pool; the public path must open fresh connections so that a
    // socket already bound to a (possibly private) address chosen by an admin
    // can never be donated to a webhook dispatch.
    const http = await import("node:http");
    let connectionCount = 0;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "2" });
      res.end("ok");
    });
    server.on("connection", () => {
      connectionCount += 1;
    });
    server.keepAliveTimeout = 30_000;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    try {
      // Admin-trusted hop #1 — opens connection #1.
      const r1 = await __pinnedHttpFetchForTests(
        new URL(`http://127.0.0.1:${port}/`),
        { method: "GET" },
        [],
      );
      await r1.text();
      expect(connectionCount).toBe(1);

      // Admin-trusted hop #2 reuses the same socket (proves keep-alive is on).
      const r2 = await __pinnedHttpFetchForTests(
        new URL(`http://127.0.0.1:${port}/`),
        { method: "GET" },
        [],
      );
      await r2.text();
      expect(connectionCount).toBe(1);

      // Public hop — must NOT reuse the admin pool's socket, even though
      // hostname:port matches.
      const r3 = await __pinnedHttpFetchForTests(
        new URL(`http://127.0.0.1:${port}/`),
        { method: "GET" },
        [{ address: "127.0.0.1", family: 4 }],
      );
      await r3.text();
      expect(connectionCount).toBe(2);

      // Second public hop also opens its own fresh connection — public path
      // never pools, so an earlier public-validated socket cannot be reused
      // for a later hostname that happened to validate to the same IP set.
      const r4 = await __pinnedHttpFetchForTests(
        new URL(`http://127.0.0.1:${port}/`),
        { method: "GET" },
        [{ address: "127.0.0.1", family: 4 }],
      );
      await r4.text();
      expect(connectionCount).toBe(3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("returns Response when headers arrive, before the body finishes", async () => {
    // Bun.serve buffers a streaming Response until the body has data, so we
    // need a server with explicit head-then-body control. node:http's
    // `flushHeaders` does exactly that.
    const http = await import("node:http");
    const BODY_DELAY_MS = 250;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "x-marker": "headers-first" });
      res.flushHeaders();
      setTimeout(() => res.end("late"), BODY_DELAY_MS);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      const start = Date.now();
      const resp = await __pinnedHttpFetchForTests(
        new URL(`http://127.0.0.1:${port}/`),
        { method: "GET" },
        [],
      );
      const headersAt = Date.now() - start;
      expect(resp.headers.get("x-marker")).toBe("headers-first");
      // Wide tolerance to absorb scheduler jitter; the assertion only fails
      // when the implementation is buffering the body.
      expect(headersAt).toBeLessThan(BODY_DELAY_MS - 80);

      const text = await resp.text();
      expect(text).toBe("late");
      expect(Date.now() - start).toBeGreaterThanOrEqual(BODY_DELAY_MS - 30);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("redirect cancellation halts the upstream body without buffering it", async () => {
    let bodyChunksSent = 0;
    let bodyAborted = false;
    let serverPort = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        if (req.url.endsWith("/final")) return new Response("done");
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (bodyChunksSent >= 100) {
                controller.close();
                return;
              }
              bodyChunksSent += 1;
              controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
              await new Promise((r) => setTimeout(r, 5));
            },
            cancel() {
              bodyAborted = true;
            },
          }),
          { status: 302, headers: { location: `http://127.0.0.1:${serverPort}/final` } },
        );
      },
    });
    serverPort = server.port ?? 0;
    try {
      __setFetchExecutorForTests(null);
      const result = await fetchHttpTarget(`http://127.0.0.1:${serverPort}/start`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.response.status).toBe(200);
        expect(await result.response.text()).toBe("done");
      }
      // The redirect body never streamed in full — cancellation reached upstream.
      expect(bodyChunksSent).toBeLessThan(50);
      expect(bodyAborted).toBe(true);
    } finally {
      server.stop(true);
      __setFetchExecutorForTests((url, init) => globalThis.fetch(url, init));
    }
  });

  test("accepts standard FetchPublicBody shapes (string, URLSearchParams, Blob, BufferSource)", async () => {
    const received: Array<{ contentType: string | null; body: string }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        received.push({ contentType: req.headers.get("content-type"), body: await req.text() });
        return new Response("ok");
      },
    });
    try {
      const url = new URL(`http://127.0.0.1:${server.port}/`);
      // string
      await __pinnedHttpFetchForTests(url, { method: "POST", body: "plain" }, []);
      // URLSearchParams
      await __pinnedHttpFetchForTests(
        url,
        {
          method: "POST",
          body: new URLSearchParams({ k: "v", x: "1" }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        },
        [],
      );
      // Blob
      await __pinnedHttpFetchForTests(
        url,
        {
          method: "POST",
          body: new Blob(["from-blob"]),
          headers: { "content-type": "application/octet-stream" },
        },
        [],
      );
      // Uint8Array (BufferSource)
      await __pinnedHttpFetchForTests(
        url,
        {
          method: "POST",
          body: new TextEncoder().encode("from-bytes"),
          headers: { "content-type": "application/octet-stream" },
        },
        [],
      );

      expect(received.map((r) => r.body)).toEqual(["plain", "k=v&x=1", "from-blob", "from-bytes"]);
    } finally {
      server.stop(true);
    }
  });
});
