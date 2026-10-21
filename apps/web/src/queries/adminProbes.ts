import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { getAdminProbeTaskOptions, getAdminProbeTasks } from "@/api/adminProbes";

export function useAdminProbeTasks(
  query: Record<string, string | number | boolean | undefined | null>,
) {
  return useQuery({
    queryKey: ["admin", "probeTasks", query],
    queryFn: () => getAdminProbeTasks(query),
    staleTime: 10_000,
    // Keep the current rows on screen while a new filter or page loads.
    placeholderData: keepPreviousData,
  });
}

export function useAdminProbeTaskOptions() {
  return useQuery({
    queryKey: ["admin", "options", "probeTasks"],
    queryFn: getAdminProbeTaskOptions,
    staleTime: 30_000,
  });
}
