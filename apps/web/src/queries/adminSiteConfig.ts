import { useQuery } from "@tanstack/react-query";

import { getAdminSiteConfig } from "@/api/adminSiteConfig";

export function useAdminSiteConfig() {
  return useQuery({
    queryKey: ["admin", "siteConfig"],
    queryFn: getAdminSiteConfig,
    staleTime: 10_000,
  });
}
