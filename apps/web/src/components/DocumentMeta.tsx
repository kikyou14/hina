import { useEffect } from "react";

import { useSiteConfig } from "./SiteConfigProvider";

export function DocumentMeta() {
  const { hasFavicon, faviconVersion, isLoaded } = useSiteConfig();

  useEffect(() => {
    if (!isLoaded) return;
    let link = document.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = hasFavicon ? `/api/public/favicon?v=${faviconVersion}` : "/api/public/favicon";
    link.removeAttribute("type");
  }, [isLoaded, hasFavicon, faviconVersion]);

  return null;
}
