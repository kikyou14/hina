import { describe, expect, test } from "bun:test";

import { checkRequestOrigin, getExpectedOrigins, normalizeOrigin } from "./origin";

const TRUSTED_PEER = "127.0.0.1";
const UNTRUSTED_PEER = "203.0.113.1";

function makeRequest(url: string, headers: Record<string, string>): Request {
  return new Request(url, { headers });
}

describe("normalizeOrigin", () => {
  test("returns canonical scheme://host[:port]", () => {
    expect(normalizeOrigin("https://example.com")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com/")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com:443")).toBe("https://example.com");
    expect(normalizeOrigin("http://example.com:8080/x")).toBe("http://example.com:8080");
    expect(normalizeOrigin("https://ExAmple.COM")).toBe("https://example.com");
  });

  test("rejects non-http schemes and malformed input", () => {
    expect(normalizeOrigin("ftp://example.com")).toBeNull();
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin("null")).toBeNull();
  });
});

describe("getExpectedOrigins", () => {
  test("uses Host and transport protocol by default", () => {
    const req = makeRequest("http://hina.example.com/live/admin", { host: "hina.example.com" });
    expect(getExpectedOrigins(req)).toEqual(["http://hina.example.com"]);
  });

  test("upgrades to https via X-Forwarded-Proto when peer is trusted", () => {
    const req = makeRequest("http://hina.example.com/live/admin", {
      host: "hina.example.com",
      "x-forwarded-proto": "https",
    });
    expect(getExpectedOrigins(req, TRUSTED_PEER)).toEqual(["https://hina.example.com"]);
  });

  test("ignores X-Forwarded-Proto when peer is public", () => {
    const req = makeRequest("http://hina.example.com/live/admin", {
      host: "hina.example.com",
      "x-forwarded-proto": "https",
    });
    expect(getExpectedOrigins(req, UNTRUSTED_PEER)).toEqual(["http://hina.example.com"]);
  });

  test("ignores X-Forwarded-Host regardless of peer trust", () => {
    // Origin is derived from the transport Host header only; reverse proxies
    // must forward the original Host. This keeps origin matching immune to
    // forged X-Forwarded-Host even when the peer would otherwise be trusted.
    const req = makeRequest("http://10.0.0.5/live/admin", {
      host: "10.0.0.5",
      "x-forwarded-host": "evil.example.com",
    });
    expect(getExpectedOrigins(req, TRUSTED_PEER)).toEqual(["http://10.0.0.5"]);
    expect(getExpectedOrigins(req, UNTRUSTED_PEER)).toEqual(["http://10.0.0.5"]);
  });
});

describe("checkRequestOrigin", () => {
  test("rejects missing Origin", () => {
    const req = makeRequest("http://hina.example.com/live/admin", {
      host: "hina.example.com",
    });
    expect(checkRequestOrigin(req)).toEqual({
      ok: false,
      reason: "missing",
      origin: null,
    });
  });

  test("rejects 'null' Origin (sandboxed iframes / file://)", () => {
    const req = makeRequest("http://hina.example.com/live/admin", {
      host: "hina.example.com",
      origin: "null",
    });
    expect(checkRequestOrigin(req)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  test("rejects unparseable Origin", () => {
    const req = makeRequest("http://hina.example.com/live/admin", {
      host: "hina.example.com",
      origin: "not-a-url",
    });
    expect(checkRequestOrigin(req)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  test("allows same-origin", () => {
    const req = makeRequest("http://hina.example.com/live/admin", {
      host: "hina.example.com",
      origin: "http://hina.example.com",
    });
    expect(checkRequestOrigin(req)).toEqual({
      ok: true,
      origin: "http://hina.example.com",
    });
  });

  test("allows same-origin behind a TLS-terminating proxy that forwards Host", () => {
    const req = makeRequest("http://hina.example.com/live/admin", {
      host: "hina.example.com",
      "x-forwarded-proto": "https",
      origin: "https://hina.example.com",
    });
    expect(checkRequestOrigin(req, { peerIp: TRUSTED_PEER })).toEqual({
      ok: true,
      origin: "https://hina.example.com",
    });
  });

  test("rejects cross-origin", () => {
    const req = makeRequest("http://hina.example.com/live/admin", {
      host: "hina.example.com",
      origin: "https://evil.example.com",
    });
    expect(checkRequestOrigin(req)).toEqual({
      ok: false,
      reason: "forbidden",
      origin: "https://evil.example.com",
    });
  });

  test("ignores forged X-Forwarded-Host even with a trusted peer", () => {
    const req = makeRequest("http://hina.example.com/live/admin", {
      host: "hina.example.com",
      "x-forwarded-host": "evil.example.com",
      origin: "http://evil.example.com",
    });
    expect(checkRequestOrigin(req, { peerIp: TRUSTED_PEER })).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
  });

  test("rejects schema mismatches even if hostname matches", () => {
    const req = makeRequest("https://hina.example.com/live/admin", {
      host: "hina.example.com",
      origin: "http://hina.example.com",
    });
    expect(checkRequestOrigin(req)).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
  });

  test("attaches a proxy-misconfig hint when X-Forwarded-Host disagrees with Host", () => {
    const req = makeRequest("http://10.0.0.5/live/admin", {
      host: "10.0.0.5",
      "x-forwarded-host": "hina.example.com",
      origin: "https://hina.example.com",
    });
    const result = checkRequestOrigin(req, { peerIp: TRUSTED_PEER });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("forbidden");
    expect(result.hint).toMatch(/proxy_set_header Host/);
    expect(result.hint).toContain("hina.example.com");
    expect(result.hint).toContain("10.0.0.5");
  });

  test("hint is omitted when X-Forwarded-Host matches Host (case-insensitive)", () => {
    const req = makeRequest("http://hina.example.com/live/admin", {
      host: "hina.example.com",
      "x-forwarded-host": "HINA.example.COM",
      origin: "https://evil.example.com",
    });
    const result = checkRequestOrigin(req);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toBeUndefined();
  });

  test("hint is omitted when X-Forwarded-Host is absent", () => {
    const req = makeRequest("http://hina.example.com/live/admin", {
      host: "hina.example.com",
      origin: "https://evil.example.com",
    });
    const result = checkRequestOrigin(req);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.hint).toBeUndefined();
  });

  test("hint is not produced for missing or invalid Origin", () => {
    const missing = checkRequestOrigin(
      makeRequest("http://10.0.0.5/", {
        host: "10.0.0.5",
        "x-forwarded-host": "hina.example.com",
      }),
    );
    expect(missing).toMatchObject({ ok: false, reason: "missing" });
    if (!missing.ok) expect(missing.hint).toBeUndefined();

    const invalid = checkRequestOrigin(
      makeRequest("http://10.0.0.5/", {
        host: "10.0.0.5",
        "x-forwarded-host": "hina.example.com",
        origin: "null",
      }),
    );
    expect(invalid).toMatchObject({ ok: false, reason: "invalid" });
    if (!invalid.ok) expect(invalid.hint).toBeUndefined();
  });
});
