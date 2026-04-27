import { useQuery } from "@tanstack/react-query";

import {
  getPublicAgent,
  getPublicAgents,
  getPublicAgentProbeLatest,
  getPublicAgentSeries,
  getPublicProbeResultsSeries,
  getPublicSiteConfig,
  type PublicProbeSeriesTier,
} from "@/api/public";

export function usePublicAgents(enabled = true) {
  return useQuery({
    queryKey: ["public", "agents"],
    queryFn: getPublicAgents,
    enabled,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function usePublicAgent(agentId: string, enabled = true) {
  return useQuery({
    queryKey: ["public", "agent", agentId],
    queryFn: () => getPublicAgent(agentId),
    enabled: enabled && agentId.length > 0,
    staleTime: 10_000,
  });
}

export function usePublicAgentSeries(
  args: {
    agentId: string;
    fromMs: number;
    toMs: number;
    resolution: "raw" | "auto";
    maxPoints: number;
  },
  enabled = true,
) {
  return useQuery({
    queryKey: [
      "public",
      "series",
      args.agentId,
      args.fromMs,
      args.toMs,
      args.resolution,
      args.maxPoints,
    ],
    queryFn: () => getPublicAgentSeries(args),
    enabled: enabled && args.agentId.length > 0 && args.toMs > args.fromMs,
    staleTime: 15_000,
  });
}

export function usePublicAgentProbeLatest(agentId: string, enabled = true) {
  return useQuery({
    queryKey: ["public", "probeLatest", agentId],
    queryFn: () => getPublicAgentProbeLatest(agentId),
    enabled: enabled && agentId.length > 0,
    staleTime: 5_000,
  });
}

export function usePublicProbeResultsSeries(
  args: {
    agentId: string;
    taskId: string;
    fromMs: number;
    toMs: number;
    tier?: PublicProbeSeriesTier;
    maxPoints?: number;
  },
  enabled = true,
) {
  return useQuery({
    queryKey: ["public", "probeResultsSeries", args],
    queryFn: () => getPublicProbeResultsSeries(args),
    enabled:
      enabled && args.agentId.length > 0 && args.taskId.length > 0 && args.toMs > args.fromMs,
    staleTime: 15_000,
  });
}

export function usePublicSiteConfig() {
  return useQuery({
    queryKey: ["public", "siteConfig"],
    queryFn: getPublicSiteConfig,
    staleTime: 300_000,
  });
}
