import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import type { PublicAgentDetailResponse, PublicAgentSummary } from "@/api/public";
import { useOptionalAdminMe } from "@/queries/admin";
import { useLiveSocket } from "./client";

type PublicLiveMessage =
  | { type: "hello.public"; tsMs: number }
  | { type: "snapshot.public.agents"; agents: PublicAgentSummary[] }
  | { type: "event.public.agent_upsert"; agent: PublicAgentSummary }
  | { type: "event.public.agent_remove"; agentId: string }
  | {
      type: "event.public.telemetry_delta";
      agentId: string;
      tsMs: number;
      metrics: Record<string, number>;
      deltaRx: number;
      deltaTx: number;
    };

function upsertAgent(list: PublicAgentSummary[], agent: PublicAgentSummary): PublicAgentSummary[] {
  const existingIndex = list.findIndex((entry) => entry.id === agent.id);
  if (existingIndex === -1) {
    return [...list, agent].sort((left: PublicAgentSummary, right: PublicAgentSummary) =>
      left.name.localeCompare(right.name, "en"),
    );
  }
  const next = [...list];
  next[existingIndex] = agent;
  return next;
}

function removeAgent(list: PublicAgentSummary[], agentId: string): PublicAgentSummary[] {
  return list.filter((entry) => entry.id !== agentId);
}

export function usePublicLiveSync(args?: {
  agentId?: string;
  liveSeries?: boolean;
  onSeriesTick?: () => void;
  onTelemetryDelta?: (message: {
    agentId: string;
    tsMs: number;
    metrics: Record<string, number>;
    deltaRx: number;
    deltaTx: number;
  }) => void;
}) {
  const queryClient = useQueryClient();
  const me = useOptionalAdminMe();
  const reconnectKey = me.data?.user?.id ?? "anon";
  const authSettled = me.isSuccess || me.isError;

  const pendingSeriesInvalidationRef = React.useRef<number | null>(null);
  const onSeriesTick = React.useEffectEvent(() => {
    args?.onSeriesTick?.();
  });
  const onTelemetryDelta = React.useEffectEvent(
    (message: {
      agentId: string;
      tsMs: number;
      metrics: Record<string, number>;
      deltaRx: number;
      deltaTx: number;
    }) => {
      args?.onTelemetryDelta?.(message);
    },
  );

  const flushSeriesInvalidation = React.useEffectEvent((agentId: string) => {
    onSeriesTick();
    queryClient.invalidateQueries({
      queryKey: ["public", "agent", agentId],
    });
    if (args?.liveSeries) {
      queryClient.invalidateQueries({
        queryKey: ["public", "series", agentId],
      });
    }
  });

  const { status } = useLiveSocket<PublicLiveMessage>({
    path: "/live/public",
    enabled: authSettled,
    reconnectKey,
    onReconnect() {
      if (args?.agentId) {
        queryClient.invalidateQueries({
          queryKey: ["public", "agent", args.agentId],
        });
        queryClient.invalidateQueries({
          queryKey: ["public", "series", args.agentId],
        });
      }
    },
    onMessage(message) {
      if (message.type === "snapshot.public.agents") {
        queryClient.setQueryData(["public", "agents"], {
          agents: message.agents,
        });
        return;
      }

      if (message.type === "event.public.agent_upsert") {
        queryClient.setQueryData<{ agents: PublicAgentSummary[] } | undefined>(
          ["public", "agents"],
          (current) => ({
            agents: upsertAgent(current?.agents ?? [], message.agent),
          }),
        );

        if (args?.agentId && args.agentId === message.agent.id) {
          queryClient.setQueryData<PublicAgentDetailResponse | undefined>(
            ["public", "agent", args.agentId],
            (current) =>
              current
                ? {
                    ...current,
                    isPublic: message.agent.isPublic ?? current.isPublic,
                    name: message.agent.name,
                    group: message.agent.group,
                    tags: message.agent.tags,
                    geo: message.agent.geo,
                    status: message.agent.status,
                    system: message.agent.system,
                    latest: message.agent.latest,
                    billing: message.agent.billing,
                    pricing: message.agent.pricing,
                  }
                : current,
          );

          if (pendingSeriesInvalidationRef.current !== null) {
            window.clearTimeout(pendingSeriesInvalidationRef.current);
          }
          pendingSeriesInvalidationRef.current = window.setTimeout(() => {
            flushSeriesInvalidation(args.agentId!);
            pendingSeriesInvalidationRef.current = null;
          }, 1000);
        }
        return;
      }

      if (message.type !== "event.public.agent_remove") {
        if (message.type === "event.public.telemetry_delta") {
          if (args?.agentId && args.agentId === message.agentId) {
            onTelemetryDelta(message);
          }
          return;
        }
        return;
      }

      queryClient.setQueryData<{ agents: PublicAgentSummary[] } | undefined>(
        ["public", "agents"],
        (current) => (current ? { agents: removeAgent(current.agents, message.agentId) } : current),
      );

      if (args?.agentId && args.agentId === message.agentId) {
        queryClient.invalidateQueries({
          queryKey: ["public", "agent", message.agentId],
        });
        if (args.liveSeries) {
          queryClient.invalidateQueries({
            queryKey: ["public", "series", message.agentId],
          });
        }
      }
    },
  });

  React.useEffect(() => {
    return () => {
      if (pendingSeriesInvalidationRef.current !== null) {
        window.clearTimeout(pendingSeriesInvalidationRef.current);
      }
    };
  }, []);

  return { status };
}
