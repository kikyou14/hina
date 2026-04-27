import { fetchJson } from "./http";

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

export type AdminSiteConfigResponse = {
  current: SiteConfig;
  defaults: SiteConfig;
};

export async function getAdminSiteConfig(): Promise<AdminSiteConfigResponse> {
  return fetchJson<AdminSiteConfigResponse>("/api/admin/system/site-config");
}

export async function patchAdminSiteConfig(
  patch: Partial<SiteConfig>,
): Promise<{ ok: true; current: SiteConfig }> {
  return fetchJson<{ ok: true; current: SiteConfig }>("/api/admin/system/site-config", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}
