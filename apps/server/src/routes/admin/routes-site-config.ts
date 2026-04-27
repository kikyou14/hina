import type { Hono } from "hono";
import type { AppContext } from "../../app";
import { SITE_CONFIG_DEFAULTS, loadSiteConfig, saveSiteConfig } from "../../settings/site-config";
import { startVersionCheck, stopVersionCheck } from "../../version-check";
import { isRecord } from "./parsing";

export function registerAdminSiteConfigRoutes(router: Hono<AppContext>) {
  router.get("/system/site-config", async (c) => {
    const db = c.get("db");
    const store = c.get("siteConfig");

    const loaded = await loadSiteConfig(db);
    store.setCurrent(loaded);

    return c.json({
      current: loaded,
      defaults: store.getDefaults(),
    });
  });

  router.patch("/system/site-config", async (c) => {
    const db = c.get("db");
    const store = c.get("siteConfig");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const patch: Partial<{
      siteName: string;
      siteDescription: string;
      favicon: string;
      customHeadHtml: string;
      customFooterHtml: string;
      timezone: string;
      sortOfflineLast: boolean;
      hideTracerouteForGuests: boolean;
      publicBaseUrl: string;
      versionCheckEnabled: boolean;
    }> = {};

    for (const field of [
      "siteName",
      "siteDescription",
      "favicon",
      "customHeadHtml",
      "customFooterHtml",
      "timezone",
      "publicBaseUrl",
    ] as const) {
      if (body[field] !== undefined) {
        if (typeof body[field] !== "string") {
          return c.json({ code: `invalid_${field}` }, 400);
        }
        patch[field] = body[field] as string;
      }
    }

    if (body.sortOfflineLast !== undefined) {
      if (typeof body.sortOfflineLast !== "boolean") {
        return c.json({ code: "invalid_sortOfflineLast" }, 400);
      }
      patch.sortOfflineLast = body.sortOfflineLast;
    }

    if (body.hideTracerouteForGuests !== undefined) {
      if (typeof body.hideTracerouteForGuests !== "boolean") {
        return c.json({ code: "invalid_hideTracerouteForGuests" }, 400);
      }
      patch.hideTracerouteForGuests = body.hideTracerouteForGuests;
    }

    if (body.versionCheckEnabled !== undefined) {
      if (typeof body.versionCheckEnabled !== "boolean") {
        return c.json({ code: "invalid_versionCheckEnabled" }, 400);
      }
      patch.versionCheckEnabled = body.versionCheckEnabled;
    }

    const CUSTOM_HTML_MAX_LENGTH = 16 * 1024;
    if (
      patch.customHeadHtml !== undefined &&
      patch.customHeadHtml.length > CUSTOM_HTML_MAX_LENGTH
    ) {
      return c.json({ code: "custom_head_html_too_large" }, 400);
    }
    if (
      patch.customFooterHtml !== undefined &&
      patch.customFooterHtml.length > CUSTOM_HTML_MAX_LENGTH
    ) {
      return c.json({ code: "custom_footer_html_too_large" }, 400);
    }

    if (patch.favicon !== undefined && patch.favicon !== "") {
      const FAVICON_MAX_LENGTH = 350 * 1024;
      if (patch.favicon.length > FAVICON_MAX_LENGTH) {
        return c.json({ code: "favicon_too_large" }, 400);
      }
      if (!/^data:image\/(svg\+xml|png|x-icon|vnd\.microsoft\.icon);base64,/.test(patch.favicon)) {
        return c.json({ code: "invalid_favicon" }, 400);
      }
    }

    if (patch.timezone !== undefined) {
      if (patch.timezone) {
        try {
          Intl.DateTimeFormat(undefined, { timeZone: patch.timezone });
        } catch {
          return c.json({ code: "invalid_timezone" }, 400);
        }
      } else {
        patch.timezone = SITE_CONFIG_DEFAULTS.timezone;
      }
    }

    if (patch.publicBaseUrl !== undefined) {
      patch.publicBaseUrl = patch.publicBaseUrl.trim().replace(/\/+$/, "");
      if (patch.publicBaseUrl) {
        try {
          const parsed = new URL(patch.publicBaseUrl);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return c.json({ code: "invalid_publicBaseUrl" }, 400);
          }
        } catch {
          return c.json({ code: "invalid_publicBaseUrl" }, 400);
        }
      }
    }

    await saveSiteConfig(db, patch);

    const current = store.getCurrent();
    const next = { ...current, ...patch };
    store.setCurrent(next);

    if (patch.versionCheckEnabled !== undefined) {
      if (patch.versionCheckEnabled) {
        startVersionCheck();
      } else {
        stopVersionCheck();
      }
    }

    return c.json({ ok: true, current: next });
  });
}
