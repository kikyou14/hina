import { describe, expect, test } from "bun:test";

import { SITE_CONFIG_DEFAULTS, SiteConfigStore, type SiteConfig } from "../settings/site-config";
import { escapeHtml, renderIndexHtml } from "./index-html";

const BASE_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="/api/public/favicon" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Hina</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

function makeStore(overrides: Partial<SiteConfig> = {}): SiteConfigStore {
  return new SiteConfigStore({
    current: { ...SITE_CONFIG_DEFAULTS, ...overrides },
  });
}

describe("escapeHtml", () => {
  test("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x & y")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x &amp; y&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });
});

describe("renderIndexHtml", () => {
  test("injects site name into <title>", () => {
    const store = makeStore({ siteName: "My Status" });
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
    });
    expect(out).toContain("<title>My Status</title>");
    expect(out).not.toContain("<title>Hina</title>");
  });

  test("escapes HTML-unsafe characters in site name", () => {
    const store = makeStore({ siteName: `Evil<script>"x"</script>` });
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
    });
    expect(out).toContain("<title>Evil&lt;script&gt;&quot;x&quot;&lt;/script&gt;</title>");
    expect(out).not.toContain("<script>");
  });

  test("falls back to 'Hina' when site name is empty", () => {
    const store = makeStore({ siteName: "" });
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
    });
    expect(out).toContain("<title>Hina</title>");
  });

  test("injects escaped description meta when set", () => {
    const store = makeStore({ siteDescription: `Watch "your" servers & stay alert` });
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
    });
    expect(out).toContain(
      `<meta name="description" content="Watch &quot;your&quot; servers &amp; stay alert" />`,
    );
  });

  test("omits description meta when empty", () => {
    const store = makeStore({ siteDescription: "" });
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
    });
    expect(out).not.toContain(`<meta name="description"`);
  });

  test("stamps favicon link with current version for cache busting", () => {
    const store = makeStore();
    const version = store.faviconVersion;
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
    });
    expect(out).toContain(`href="/api/public/favicon?v=${version}"`);
    expect(out).not.toContain(`href="/api/public/favicon"`);
  });

  test("re-stamps favicon even if template already has a query string", () => {
    const template = BASE_TEMPLATE.replace(
      `href="/api/public/favicon"`,
      `href="/api/public/favicon?v=stale"`,
    );
    const store = makeStore();
    const out = renderIndexHtml({
      template,
      siteConfig: store,
      isAdminPath: false,
    });
    expect(out).toContain(`href="/api/public/favicon?v=${store.faviconVersion}"`);
    expect(out).not.toContain("v=stale");
  });

  test("injects custom head HTML verbatim on public paths", () => {
    const snippet = `<script async src="https://analytics.example.com/track.js"></script>`;
    const store = makeStore({ customHeadHtml: snippet });
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
    });
    expect(out).toContain(snippet);
    // Must land inside <head>, before </head>.
    const headEnd = out.indexOf("</head>");
    expect(headEnd).toBeGreaterThan(-1);
    expect(out.indexOf(snippet)).toBeLessThan(headEnd);
  });

  test("omits custom head HTML on admin paths", () => {
    const snippet = `<script>trackAdmin()</script>`;
    const store = makeStore({ customHeadHtml: snippet });
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: true,
    });
    expect(out).not.toContain(snippet);
  });

  test("omits custom head HTML when only whitespace", () => {
    const store = makeStore({ customHeadHtml: "   \n\t " });
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
    });
    // Nothing extra should be injected besides the title/favicon changes.
    expect(out).not.toContain("   \n\t ");
  });

  test("leaves template intact when nothing needs injecting", () => {
    const store = makeStore({
      siteName: "Hina",
      siteDescription: "",
      customHeadHtml: "",
    });
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
    });
    expect(out).toContain("<title>Hina</title>");
    expect(out).not.toContain(`<meta name="description"`);
    expect(out).toContain(`href="/api/public/favicon?v=${store.faviconVersion}"`);
  });

  test("injects nonce into template script tags", () => {
    const store = makeStore();
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
      nonce: "abc123",
    });
    expect(out).toContain(`<script nonce="abc123" type="module" src="/src/main.tsx">`);
    expect(out).not.toContain(`<script type="module"`);
  });

  test("injects nonce into customHeadHtml script tags", () => {
    const snippet = `<script async src="https://analytics.example.com/track.js"></script>`;
    const store = makeStore({ customHeadHtml: snippet });
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
      nonce: "xyz789",
    });
    expect(out).toContain(
      `<script nonce="xyz789" async src="https://analytics.example.com/track.js">`,
    );
  });

  test("injects nonce into inline customHeadHtml script tags", () => {
    const snippet = `<script>ga("send","pageview")</script>`;
    const store = makeStore({ customHeadHtml: snippet });
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
      nonce: "n0nce",
    });
    expect(out).toContain(`<script nonce="n0nce">ga("send","pageview")</script>`);
  });

  test("skips nonce injection when nonce contains dangerous characters", () => {
    const store = makeStore();
    const malicious = `" onload="alert(1)`;
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
      nonce: malicious,
    });
    expect(out).not.toContain("nonce");
    expect(out).not.toContain("onload");
    expect(out).toContain(`<script type="module" src="/src/main.tsx">`);
  });

  test("skips nonce injection when nonce is undefined", () => {
    const store = makeStore();
    const out = renderIndexHtml({
      template: BASE_TEMPLATE,
      siteConfig: store,
      isAdminPath: false,
    });
    expect(out).toContain(`<script type="module" src="/src/main.tsx">`);
    expect(out).not.toContain("nonce");
  });
});
