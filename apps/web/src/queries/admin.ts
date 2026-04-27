import { useQuery, type QueryClient } from "@tanstack/react-query";

import { adminMe, adminMeOptional } from "@/api/admin";

export const adminMeQueryKey = ["admin", "me"] as const;
export const adminMeOptionalQueryKey = ["admin", "me", "optional"] as const;

export async function invalidateAdminMeQueries(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: adminMeQueryKey }),
    queryClient.invalidateQueries({ queryKey: adminMeOptionalQueryKey }),
  ]);
}

export async function invalidatePublicQueries(queryClient: QueryClient) {
  await queryClient.invalidateQueries({ queryKey: ["public"] });
}

export function clearPrivilegedCache(queryClient: QueryClient) {
  queryClient.removeQueries({ queryKey: ["public"] });
  queryClient.removeQueries({ queryKey: ["admin"] });
}

export function useAdminMe() {
  return useQuery({
    queryKey: adminMeQueryKey,
    queryFn: adminMe,
    staleTime: 10_000,
  });
}

export function useOptionalAdminMe() {
  return useQuery({
    queryKey: adminMeOptionalQueryKey,
    queryFn: adminMeOptional,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}
