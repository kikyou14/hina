import { eq, or } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { appKv } from "../db/schema";

export type SiteConfig = {
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
};

export const SITE_CONFIG_DEFAULTS: SiteConfig = {
  siteName: "Hina",
  siteDescription: "",
  favicon: "",
  customHeadHtml: "",
  customFooterHtml: "",
  timezone: process.env.TZ || "Asia/Shanghai",
  sortOfflineLast: false,
  hideTracerouteForGuests: false,
  publicBaseUrl: process.env.HINA_PUBLIC_BASE_URL ?? "",
  versionCheckEnabled: true,
};

const KV_KEYS = {
  siteName: "site.siteName",
  siteDescription: "site.siteDescription",
  favicon: "site.favicon",
  customHeadHtml: "site.customHeadHtml",
  customFooterHtml: "site.customFooterHtml",
  timezone: "site.timezone",
  sortOfflineLast: "site.sortOfflineLast",
  hideTracerouteForGuests: "site.hideTracerouteForGuests",
  publicBaseUrl: "site.publicBaseUrl",
  versionCheckEnabled: "site.versionCheckEnabled",
} as const;

export async function loadSiteConfig(db: DbClient): Promise<SiteConfig> {
  const rows = await db
    .select({ key: appKv.key, value: appKv.value })
    .from(appKv)
    .where(
      or(
        eq(appKv.key, KV_KEYS.siteName),
        eq(appKv.key, KV_KEYS.siteDescription),
        eq(appKv.key, KV_KEYS.favicon),
        eq(appKv.key, KV_KEYS.customHeadHtml),
        eq(appKv.key, KV_KEYS.customFooterHtml),
        eq(appKv.key, KV_KEYS.timezone),
        eq(appKv.key, KV_KEYS.sortOfflineLast),
        eq(appKv.key, KV_KEYS.hideTracerouteForGuests),
        eq(appKv.key, KV_KEYS.publicBaseUrl),
        eq(appKv.key, KV_KEYS.versionCheckEnabled),
      )!,
    );

  const config: SiteConfig = { ...SITE_CONFIG_DEFAULTS };

  for (const row of rows) {
    if (row.key === KV_KEYS.siteName) {
      config.siteName = row.value || SITE_CONFIG_DEFAULTS.siteName;
    } else if (row.key === KV_KEYS.siteDescription) {
      config.siteDescription = row.value;
    } else if (row.key === KV_KEYS.favicon) {
      config.favicon = row.value;
    } else if (row.key === KV_KEYS.customHeadHtml) {
      config.customHeadHtml = row.value;
    } else if (row.key === KV_KEYS.customFooterHtml) {
      config.customFooterHtml = row.value;
    } else if (row.key === KV_KEYS.timezone) {
      config.timezone = row.value || SITE_CONFIG_DEFAULTS.timezone;
    } else if (row.key === KV_KEYS.sortOfflineLast) {
      config.sortOfflineLast = row.value === "true";
    } else if (row.key === KV_KEYS.hideTracerouteForGuests) {
      config.hideTracerouteForGuests = row.value === "true";
    } else if (row.key === KV_KEYS.publicBaseUrl) {
      config.publicBaseUrl = row.value || SITE_CONFIG_DEFAULTS.publicBaseUrl;
    } else if (row.key === KV_KEYS.versionCheckEnabled) {
      config.versionCheckEnabled = row.value !== "false";
    }
  }

  return config;
}

export async function saveSiteConfig(db: DbClient, patch: Partial<SiteConfig>): Promise<void> {
  const nowMs = Date.now();
  const entries: Array<{ key: string; value: string; updatedAtMs: number }> = [];

  for (const [field, kvKey] of Object.entries(KV_KEYS) as Array<
    [keyof SiteConfig, (typeof KV_KEYS)[keyof SiteConfig]]
  >) {
    if (patch[field] !== undefined) {
      entries.push({ key: kvKey, value: String(patch[field]), updatedAtMs: nowMs });
    }
  }

  for (const row of entries) {
    await db
      .insert(appKv)
      .values(row)
      .onConflictDoUpdate({
        target: appKv.key,
        set: { value: row.value, updatedAtMs: row.updatedAtMs },
      });
  }
}

export class SiteConfigStore {
  private current: SiteConfig;
  private _faviconVersion = Date.now();

  constructor(args: { current: SiteConfig }) {
    this.current = { ...args.current };
  }

  getDefaults(): SiteConfig {
    return { ...SITE_CONFIG_DEFAULTS };
  }

  getCurrent(): SiteConfig {
    return { ...this.current };
  }

  get faviconVersion(): number {
    return this._faviconVersion;
  }

  setCurrent(config: SiteConfig) {
    if (config.favicon !== this.current.favicon) {
      this._faviconVersion = Date.now();
    }
    this.current = { ...config };
  }
}
