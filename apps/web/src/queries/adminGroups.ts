import { type QueryClient, useQuery } from "@tanstack/react-query";

import { getAdminGroups } from "@/api/adminGroups";

export const adminGroupsQueryKey = ["admin", "groups"] as const;

export function invalidateAdminGroups(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: adminGroupsQueryKey });
}

export function useAdminGroups() {
  return useQuery({
    queryKey: adminGroupsQueryKey,
    queryFn: async () => {
      const res = await getAdminGroups();
      return res.groups;
    },
    staleTime: 60_000,
  });
}
