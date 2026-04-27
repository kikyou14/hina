import { useEffect } from "react";

import { useSiteConfig } from "@/components/SiteConfigProvider";

export function useDocumentTitle(page?: string): void {
  const { siteName } = useSiteConfig();

  useEffect(() => {
    document.title = page ? `${page} | ${siteName}` : siteName;
    return () => {
      document.title = siteName;
    };
  }, [page, siteName]);
}
