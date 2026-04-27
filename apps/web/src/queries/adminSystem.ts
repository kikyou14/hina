import { useQuery } from "@tanstack/react-query";

import { getAdminRuntimeConfig, getAsnDbStatus, getDbStatus } from "@/api/adminSystem";

export function useAdminRuntimeConfig() {
  return useQuery({
    queryKey: ["admin", "runtimeConfig"],
    queryFn: getAdminRuntimeConfig,
    staleTime: 10_000,
  });
}

export function useAsnDbStatus() {
  return useQuery({
    queryKey: ["admin", "asnDbStatus"],
    queryFn: getAsnDbStatus,
    staleTime: 10_000,
  });
}

export function useDbStatus() {
  return useQuery({
    queryKey: ["admin", "dbStatus"],
    queryFn: getDbStatus,
    staleTime: 10_000,
  });
}
