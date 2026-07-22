import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import type { PublicAgentDetailResponse, PublicAgentSummary } from "@/api/public";
import { useOptionalAdminMe } from "@/queries/admin";
import {
  applyAgentOps,
  applyLivePatch,
  hasUpsert,
  type AgentLivePatch,
  type PendingAgentOp,
} from "./agentOps";
import { useLiveSocket } from "./client";
import { isPublicTelemetryDeltaV2, type PublicLiveMessage } from "./publicMessages";

const LIST_FLUSH_INTERVAL_MS = 500;

const PUBLIC_LIVE_PROTOCOL = 2;

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
    rx?: number;
    tx?: number;
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
      rx?: number;
      tx?: number;
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

  const pendingAgentOpsRef = React.useRef<Map<string, PendingAgentOp>>(new Map());
  const listFlushTimerRef = React.useRef<number | null>(null);

  const flushAgentOps = React.useEffectEvent(() => {
    const ops = pendingAgentOpsRef.current;
    if (ops.size === 0) return;
    pendingAgentOpsRef.current = new Map();
    queryClient.setQueryData<{ agents: PublicAgentSummary[] } | undefined>(
      ["public", "agents"],
      (current) => {
        if (!current && !hasUpsert(ops)) return current;
        return { agents: applyAgentOps(current?.agents ?? [], ops) };
      },
    );
  });

  const scheduleAgentFlush = React.useEffectEvent(() => {
    if (listFlushTimerRef.current !== null) return;
    listFlushTimerRef.current = window.setTimeout(() => {
      listFlushTimerRef.current = null;
      flushAgentOps();
    }, LIST_FLUSH_INTERVAL_MS);
  });

  const { status } = useLiveSocket<PublicLiveMessage>({
    path: "/live/public",
    protocolVersion: PUBLIC_LIVE_PROTOCOL,
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
        pendingAgentOpsRef.current.clear();
        if (listFlushTimerRef.current !== null) {
          window.clearTimeout(listFlushTimerRef.current);
          listFlushTimerRef.current = null;
        }
        queryClient.setQueryData(["public", "agents"], { agents: message.agents });
        return;
      }

      if (message.type === "event.public.agent_upsert") {
        pendingAgentOpsRef.current.set(message.agent.id, {
          kind: "upsert",
          agent: message.agent,
        });
        scheduleAgentFlush();

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
                    traffic: message.agent.traffic,
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

      if (message.type === "event.public.agent_remove") {
        pendingAgentOpsRef.current.set(message.agentId, { kind: "remove" });
        scheduleAgentFlush();

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
        return;
      }

      if (message.type === "event.public.telemetry_delta") {
        const v2 = isPublicTelemetryDeltaV2(message) ? message : null;
        if (v2) {
          const patch: AgentLivePatch = {
            tsMs: v2.tsMs,
            latest: {
              seq: v2.seq,
              uptimeSec: v2.uptimeSec,
              rx: v2.rx,
              tx: v2.tx,
              m: v2.metrics,
            },
            billing: v2.billing,
            traffic: v2.traffic,
          };

          const ops = pendingAgentOpsRef.current;
          const existing = ops.get(v2.agentId);
          if (existing?.kind === "upsert") {
            ops.set(v2.agentId, {
              kind: "upsert",
              agent: applyLivePatch(existing.agent, patch),
            });
          } else if (existing?.kind !== "remove") {
            ops.set(v2.agentId, { kind: "patch", patch });
          }
          scheduleAgentFlush();

          if (args?.agentId && args.agentId === v2.agentId) {
            queryClient.setQueryData<PublicAgentDetailResponse | undefined>(
              ["public", "agent", args.agentId],
              (current) => (current ? applyLivePatch(current, patch) : current),
            );
          }
        }

        if (args?.agentId && args.agentId === message.agentId) {
          onTelemetryDelta({
            agentId: message.agentId,
            tsMs: message.tsMs,
            metrics: message.metrics,
            deltaRx: message.deltaRx,
            deltaTx: message.deltaTx,
            rx: v2?.rx,
            tx: v2?.tx,
          });
        }
        return;
      }
    },
  });

  React.useEffect(() => {
    return () => {
      pendingAgentOpsRef.current.clear();
      if (listFlushTimerRef.current !== null) {
        window.clearTimeout(listFlushTimerRef.current);
        listFlushTimerRef.current = null;
      }
    };
  }, [reconnectKey]);

  React.useEffect(() => {
    return () => {
      if (pendingSeriesInvalidationRef.current !== null) {
        window.clearTimeout(pendingSeriesInvalidationRef.current);
      }
    };
  }, []);

  return { status };
}
