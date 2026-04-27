import { createContext, useContext, useMemo } from "react";

import { usePublicSiteConfig } from "@/queries/public";

type SiteConfigState = {
  siteName: string;
  siteDescription: string;
  hasFavicon: boolean;
  faviconVersion: number;
  customFooterHtml: string;
  timezone: string;
  sortOfflineLast: boolean;
  hideTracerouteForGuests: boolean;
  isLoaded: boolean;
};

const SiteConfigContext = createContext<SiteConfigState>({
  siteName: "Hina",
  siteDescription: "",
  hasFavicon: false,
  faviconVersion: 0,
  customFooterHtml: "",
  timezone: "Asia/Shanghai",
  sortOfflineLast: false,
  hideTracerouteForGuests: false,
  isLoaded: false,
});

export function SiteConfigProvider({ children }: { children: React.ReactNode }) {
  const { data } = usePublicSiteConfig();

  const value = useMemo<SiteConfigState>(
    () => ({
      siteName: data?.siteName || "Hina",
      siteDescription: data?.siteDescription ?? "",
      hasFavicon: data?.hasFavicon ?? false,
      faviconVersion: data?.faviconVersion ?? 0,
      customFooterHtml: data?.customFooterHtml ?? "",
      timezone: data?.timezone || "Asia/Shanghai",
      sortOfflineLast: data?.sortOfflineLast ?? false,
      hideTracerouteForGuests: data?.hideTracerouteForGuests ?? false,
      isLoaded: !!data,
    }),
    [data],
  );

  return <SiteConfigContext.Provider value={value}>{children}</SiteConfigContext.Provider>;
}

export function useSiteConfig() {
  return useContext(SiteConfigContext);
}
