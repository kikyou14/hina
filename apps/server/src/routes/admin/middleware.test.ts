import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppContext } from "../../app";
import { createOriginGuard } from "./middleware";

const HOST = "hina.example.com";
const SAME_ORIGIN = `http://${HOST}`;
const EVIL_ORIGIN = "http://evil.example.com";
const SESSION_COOKIE = "hina_session=tok";
const TRUSTED_PEER = "127.0.0.1";

function buildApp() {
  const app = new Hono<AppContext>();
  app.use("*", createOriginGuard());
  app.get("/r", (c) => c.json({ ok: true }));
  app.post("/r", (c) => c.json({ ok: true }));
  app.put("/r", (c) => c.json({ ok: true }));
  app.patch("/r", (c) => c.json({ ok: true }));
  app.delete("/r", (c) => c.json({ ok: true }));
  return app;
}

function fetchWith(
  app: ReturnType<typeof buildApp>,
  init: { method?: string; headers?: Record<string, string> } & { peerIp?: string } = {},
) {
  const { peerIp, ...reqInit } = init;
  const req = new Request(`http://${HOST}/r`, reqInit);
  return app.fetch(req, { connectionIp: peerIp });
}

describe("createOriginGuard", () => {
  test("safe methods pass without Origin or auth", async () => {
    const app = buildApp();
    const res = await fetchWith(app, { headers: { host: HOST } });
    expect(res.status).toBe(200);
  });

  test("POST without Origin (cookie session) is rejected", async () => {
    const app = buildApp();
    const res = await fetchWith(app, {
      method: "POST",
      headers: { host: HOST, cookie: SESSION_COOKIE },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: "forbidden_origin" });
  });

  test("POST with same-origin Origin is allowed", async () => {
    const app = buildApp();
    const res = await fetchWith(app, {
      method: "POST",
      headers: { host: HOST, origin: SAME_ORIGIN, cookie: SESSION_COOKIE },
    });
    expect(res.status).toBe(200);
  });

  test("POST with cross-origin (sibling subdomain) is rejected", async () => {
    const app = buildApp();
    const res = await fetchWith(app, {
      method: "POST",
      headers: { host: HOST, origin: EVIL_ORIGIN, cookie: SESSION_COOKIE },
    });
    expect(res.status).toBe(403);
  });

  test("Bearer-only POST without Origin is allowed (CLI / server-to-server)", async () => {
    const app = buildApp();
    const res = await fetchWith(app, {
      method: "POST",
      headers: { host: HOST, authorization: "Bearer some-token" },
    });
    expect(res.status).toBe(200);
  });

  test("Bearer + cookie + bad Origin is rejected (cookie present takes the strict path)", async () => {
    const app = buildApp();
    const res = await fetchWith(app, {
      method: "POST",
      headers: {
        host: HOST,
        authorization: "Bearer some-token",
        cookie: SESSION_COOKIE,
        origin: EVIL_ORIGIN,
      },
    });
    expect(res.status).toBe(403);
  });

  test("login-CSRF: POST to login without Origin is rejected even without cookie", async () => {
    // Anonymous CSRF on /session/login (forced session fixation): no cookie,
    // no Bearer, only the attacker's origin. The guard must still reject.
    const app = buildApp();
    const res = await fetchWith(app, {
      method: "POST",
      headers: { host: HOST, origin: EVIL_ORIGIN },
    });
    expect(res.status).toBe(403);
  });

  test("DELETE without Origin and without Bearer is rejected", async () => {
    const app = buildApp();
    const res = await fetchWith(app, { method: "DELETE", headers: { host: HOST } });
    expect(res.status).toBe(403);
  });

  test("PATCH and PUT are also guarded", async () => {
    const app = buildApp();
    const patchRes = await fetchWith(app, {
      method: "PATCH",
      headers: { host: HOST, origin: EVIL_ORIGIN, cookie: SESSION_COOKIE },
    });
    expect(patchRes.status).toBe(403);

    const putRes = await fetchWith(app, {
      method: "PUT",
      headers: { host: HOST, origin: EVIL_ORIGIN, cookie: SESSION_COOKIE },
    });
    expect(putRes.status).toBe(403);
  });

  test("X-Forwarded-Proto from a trusted peer upgrades the expected origin to https", async () => {
    // Behind a TLS-terminating reverse proxy: external Origin is https, the
    // internal Host stays http. With a trusted peerIp the guard must accept it.
    const app = buildApp();
    const res = await fetchWith(app, {
      method: "POST",
      headers: {
        host: HOST,
        "x-forwarded-proto": "https",
        origin: `https://${HOST}`,
        cookie: SESSION_COOKIE,
      },
      peerIp: TRUSTED_PEER,
    });
    expect(res.status).toBe(200);
  });

  test("X-Forwarded-Host is ignored: forged value cannot whitelist a foreign Origin", async () => {
    // Even from a trusted peer, X-Forwarded-Host must not steer origin matching.
    const app = buildApp();
    const res = await fetchWith(app, {
      method: "POST",
      headers: {
        host: "10.0.0.5",
        "x-forwarded-host": HOST,
        origin: SAME_ORIGIN,
        cookie: SESSION_COOKIE,
      },
      peerIp: TRUSTED_PEER,
    });
    expect(res.status).toBe(403);
  });
});
