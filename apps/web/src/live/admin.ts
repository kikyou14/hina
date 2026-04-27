import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";

import type { AdminAgent, AdminAgentDetail, AdminAgentsResponse } from "@/api/adminAgents";
import type { AdminProbeLatest, AdminProbeTaskRef } from "@/api/adminProbes";
import { useLiveSocket } from "./client";

type AdminAgentDeltaMessage = {
  type: "event.admin.agent_delta";
  agentId: string;
  status: {
    online: boolean;
    lastSeenAtMs: number | null;
    lastIpV4?: string | null;
    lastIpV6?: string | null;
  };
  latest?: {
    seq: number;
    rx: number;
    tx: number;
    m: Record<string, unknown>;
  } | null;
};

type AdminAgentGeoMessage = {
  type: "event.admin.agent_geo";
  agentId: string;
  geo: {
    countryCode: string;
    country: string;
    source: string;
  };
};

type AdminProbeLatestMessage = {
  type: "event.admin.probe_latest";
  agentId: string;
  taskId: string;
  latest: AdminProbeLatest;
};

type AdminLiveMessage =
  | { type: "hello.admin"; tsMs: number }
  | AdminAgentDeltaMessage
  | AdminAgentGeoMessage
  | AdminProbeLatestMessage;

export function patchAdminAgent<T extends AdminAgent>(agent: T, delta: AdminAgentDeltaMessage): T {
  if (agent.id !== delta.agentId) return agent;
  return {
    ...agent,
    status: {
      ...agent.status,
      online: delta.status.online,
      lastSeenAtMs: delta.status.lastSeenAtMs,
      lastIpV4: delta.status.lastIpV4 === undefined ? agent.status.lastIpV4 : delta.status.lastIpV4,
      lastIpV6: delta.status.lastIpV6 === undefined ? agent.status.lastIpV6 : delta.status.lastIpV6,
    },
    latest: delta.latest === undefined ? agent.latest : delta.latest,
  };
}

function patchAgentLatestData(
  current:
    | {
        agentId: string;
        results: Array<{
          task: AdminProbeTaskRef;
          latest: AdminProbeLatest;
        }>;
      }
    | undefined,
  message: AdminProbeLatestMessage,
) {
  if (!current || current.agentId !== message.agentId) return current;
  const existingIndex = current.results.findIndex((entry) => entry.task.id === message.taskId);
  if (existingIndex === -1) {
    return {
      ...current,
      results: [
        ...current.results,
        {
          task: {
            id: message.taskId,
            name: null,
            kind: null,
            enabled: null,
            intervalSec: null,
            timeoutMs: null,
            target: null,
          },
          latest: message.latest,
        },
      ],
    };
  }
  const next = [...current.results];
  next[existingIndex] = {
    ...next[existingIndex]!,
    latest: message.latest,
  };
  return {
    ...current,
    results: next,
  };
}

function setQueryDataSafe<T>(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: QueryKey,
  updater: (current: T | undefined) => T | undefined,
) {
  queryClient.setQueryData<T | undefined>(queryKey, updater);
}

export function useAdminLiveSync() {
  const queryClient = useQueryClient();

  const { status } = useLiveSocket<AdminLiveMessage>({
    path: "/live/admin",
    onReconnect() {
      queryClient.invalidateQueries({ queryKey: ["admin", "agents"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "agent"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "agentProbeLatest"] });
    },
    onMessage(message) {
      if (message.type === "event.admin.agent_delta") {
        const queryCache = queryClient.getQueryCache();
        for (const query of queryCache.findAll({
          queryKey: ["admin", "agents"],
        })) {
          setQueryDataSafe<AdminAgentsResponse>(queryClient, query.queryKey, (current) =>
            current
              ? {
                  ...current,
                  agents: current.agents.map((agent) => patchAdminAgent(agent, message)),
                }
              : current,
          );
        }
        setQueryDataSafe<AdminAgentDetail>(
          queryClient,
          ["admin", "agent", message.agentId],
          (current) => (current ? patchAdminAgent(current, message) : current),
        );
        return;
      }

      if (message.type === "event.admin.agent_geo") {
        const patchGeo = <T extends AdminAgent>(a: T): T =>
          a.id === message.agentId ? { ...a, geo: { ...a.geo, ...message.geo } } : a;

        const queryCache = queryClient.getQueryCache();
        for (const query of queryCache.findAll({
          queryKey: ["admin", "agents"],
        })) {
          setQueryDataSafe<AdminAgentsResponse>(queryClient, query.queryKey, (current) =>
            current ? { ...current, agents: current.agents.map(patchGeo) } : current,
          );
        }
        setQueryDataSafe<AdminAgentDetail>(
          queryClient,
          ["admin", "agent", message.agentId],
          (current) => (current ? patchGeo(current) : current),
        );
        return;
      }

      if (message.type !== "event.admin.probe_latest") return;

      setQueryDataSafe<{
        agentId: string;
        results: Array<{ task: AdminProbeTaskRef; latest: AdminProbeLatest }>;
      }>(queryClient, ["admin", "agentProbeLatest", message.agentId], (current) =>
        patchAgentLatestData(current, message),
      );
    },
  });

  return { status };
}
