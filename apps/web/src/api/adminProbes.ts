import { fetchJson } from "./http";

export type ProbeKind = "icmp" | "tcp" | "http" | "traceroute";

export type ProbeTaskTarget = { host: string } | { host: string; port: number } | { url: string };

export type AdminProbeTask = {
  id: string;
  name: string;
  kind: ProbeKind;
  enabled: boolean;
  allAgents: boolean;
  traceRevealHopDetails: boolean;
  intervalSec: number;
  timeoutMs: number;
  target: ProbeTaskTarget | null;
  createdAtMs: number;
  updatedAtMs: number;
  groups: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
};

export type AdminProbeTaskRef = {
  id: string;
  name: string | null;
  kind: ProbeKind | null;
  enabled: boolean | null;
  intervalSec: number | null;
  timeoutMs: number | null;
  target: ProbeTaskTarget | null;
};

export type AdminProbeLatest = {
  tsMs: number;
  recvTsMs: number;
  ok: boolean;
  latMs: number | null;
  code: number | null;
  err: string | null;
  extra: unknown | null;
  lossPct: number | null;
  jitterMs: number | null;
  updatedAtMs: number;
};

export type AdminProbeTasksResponse = {
  total: number;
  limit: number;
  offset: number;
  tasks: AdminProbeTask[];
};

export type AdminProbeTaskOption = {
  id: string;
  name: string;
  kind: ProbeKind;
};

export async function getAdminProbeTasks(
  query?: Record<string, string | number | boolean | undefined | null>,
): Promise<AdminProbeTasksResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  const suffix = qs.size ? `?${qs.toString()}` : "";
  return fetchJson<AdminProbeTasksResponse>(`/api/admin/probe-tasks${suffix}`);
}

export async function getAdminProbeTaskOptions(): Promise<{ tasks: AdminProbeTaskOption[] }> {
  return fetchJson<{ tasks: AdminProbeTaskOption[] }>("/api/admin/probe-tasks/options");
}

export async function createAdminProbeTask(args: {
  name: string;
  kind: ProbeKind;
  target: ProbeTaskTarget;
  intervalSec: number;
  timeoutMs: number;
  enabled?: boolean;
  allAgents?: boolean;
  traceRevealHopDetails?: boolean;
  groupIds?: string[];
  agentIds?: string[];
}): Promise<{ ok: true; id: string }> {
  return fetchJson<{ ok: true; id: string }>("/api/admin/probe-tasks", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function patchAdminProbeTask(
  taskId: string,
  patch: Partial<{
    name: string;
    kind: ProbeKind;
    target: ProbeTaskTarget;
    intervalSec: number;
    timeoutMs: number;
    enabled: boolean;
    allAgents: boolean;
    traceRevealHopDetails: boolean;
    groupIds: string[];
    agentIds: string[];
  }>,
): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>(`/api/admin/probe-tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteAdminProbeTask(taskId: string): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>(`/api/admin/probe-tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
}

export async function reorderAdminProbeTasks(taskIds: string[]): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>("/api/admin/probe-tasks/reorder", {
    method: "PUT",
    body: JSON.stringify({ taskIds }),
  });
}

export async function getAdminAgentProbeLatest(agentId: string): Promise<{
  agentId: string;
  results: Array<{
    task: AdminProbeTaskRef;
    latest: AdminProbeLatest;
  }>;
}> {
  return fetchJson<{
    agentId: string;
    results: Array<{
      task: AdminProbeTaskRef;
      latest: AdminProbeLatest;
    }>;
  }>(`/api/admin/agents/${encodeURIComponent(agentId)}/probe-latest`);
}
