import type { AdminAgentSystem, AgentInventory } from "./agentInfo";
import { fetchJson } from "./http";

export type BillingMode = "sum" | "rx" | "tx" | "max";

export type AgentPricing = {
  currency: string;
  cycle: string;
  amountUnit: number;
  expiresAtMs: number | null;
};

export type AdminAgent = {
  id: string;
  name: string;
  isPublic: boolean;
  displayOrder: number;
  tags: string[];
  note: string | null;
  group: string | null;
  groupId: string | null;
  geo: {
    countryCode: string | null;
    country: string | null;
    source: string | null;
  };
  status: {
    online: boolean;
    lastSeenAtMs: number | null;
    lastIpV4: string | null;
    lastIpV6: string | null;
  };
  system: AdminAgentSystem;
  latest: {
    seq: number;
    uptimeSec?: number | null;
    rx: number;
    tx: number;
    m: Record<string, unknown>;
  } | null;
  billing: {
    quotaBytes: number;
    mode: BillingMode;
    resetDay: number;
    periodStartDayYyyyMmDd: number;
    periodEndDayYyyyMmDd: number;
    rxBytes: number;
    txBytes: number;
    usedBytes: number;
    overQuota: boolean;
  };
  pricing: AgentPricing | null;
};

export type AdminAgentDetail = AdminAgent & {
  inventory: AgentInventory | null;
};

export type AdminAgentsResponse = {
  total: number;
  limit: number;
  offset: number;
  agents: AdminAgent[];
};

export type AdminAgentOption = {
  id: string;
  name: string;
  group: string | null;
};

export async function getAdminAgents(
  query?: Record<string, string | number | boolean | undefined | null>,
): Promise<AdminAgentsResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    qs.set(k, String(v));
  }
  const suffix = qs.size ? `?${qs.toString()}` : "";
  return fetchJson<AdminAgentsResponse>(`/api/admin/agents${suffix}`);
}

export async function getAdminAgentOptions(): Promise<{ agents: AdminAgentOption[] }> {
  return fetchJson<{ agents: AdminAgentOption[] }>("/api/admin/agents/options");
}

export async function getAdminAgent(agentId: string): Promise<AdminAgentDetail> {
  return fetchJson<AdminAgentDetail>(`/api/admin/agents/${encodeURIComponent(agentId)}`);
}

export async function createAdminAgent(args: {
  name: string;
  groupName?: string;
  isPublic?: boolean;
  token?: string;
  tags?: string[];
  note?: string | null;
  pricing?: AgentPricing;
}): Promise<{ ok: true; id: string; token: string }> {
  return fetchJson<{ ok: true; id: string; token: string }>("/api/admin/agents", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function patchAdminAgent(
  agentId: string,
  patch: Partial<{
    name: string;
    isPublic: boolean;
    note: string | null;
    tags: string[];
    groupName: string | null;
    billing: { quotaBytes: number; mode: BillingMode; resetDay: number };
    pricing: AgentPricing | null;
  }>,
): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>(`/api/admin/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteAdminAgent(agentId: string): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>(`/api/admin/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
}

export async function reorderAdminAgents(agentIds: string[]): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>("/api/admin/agents/reorder", {
    method: "PUT",
    body: JSON.stringify({ agentIds }),
  });
}

export async function rotateAdminAgentToken(agentId: string): Promise<{ ok: true; token: string }> {
  return fetchJson<{ ok: true; token: string }>(
    `/api/admin/agents/${encodeURIComponent(agentId)}/rotate-token`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}
