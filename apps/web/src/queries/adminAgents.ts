import { useQuery } from "@tanstack/react-query";

import { getAdminAgent, getAdminAgentOptions, getAdminAgents } from "@/api/adminAgents";

export function useAdminAgents(
  query: Record<string, string | number | boolean | undefined | null>,
) {
  return useQuery({
    queryKey: ["admin", "agents", query],
    queryFn: () => getAdminAgents(query),
    staleTime: 10_000,
  });
}

export function useAdminAgent(agentId: string) {
  return useQuery({
    queryKey: ["admin", "agent", agentId],
    queryFn: () => getAdminAgent(agentId),
    enabled: agentId.length > 0,
    staleTime: 10_000,
  });
}

export function useAdminAgentOptions() {
  return useQuery({
    queryKey: ["admin", "options", "agents"],
    queryFn: getAdminAgentOptions,
    staleTime: 30_000,
  });
}
