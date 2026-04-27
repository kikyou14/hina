import { fetchJson } from "./http";

export type AlertChannelType =
  | "webhook"
  | "telegram"
  | "email"
  | "serverchan3"
  | "serverchanturbo"
  | "bark";

export type AdminAlertChannel = {
  id: string;
  name: string;
  type: AlertChannelType;
  enabled: boolean;
  config: unknown;
  meta: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
};

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertRuleKind =
  | "agent_offline"
  | "metric_threshold"
  | "probe_failed"
  | "probe_latency"
  | "quota_exceeded"
  | "agent_expiring"
  | "route_change";

export type AgentSelector =
  | { type: "all" }
  | { type: "agents"; agentIds: string[] }
  | { type: "groups"; groupIds: string[] };

export type AdminAlertRule = {
  id: string;
  name: string;
  enabled: boolean;
  severity: AlertSeverity;
  kind: AlertRuleKind;
  selector: AgentSelector;
  params: unknown;
  forMs: number;
  recoverMs: number;
  notifyOnRecovery: boolean;
  channels: Array<{ id: string; name: string; type: string; enabled: boolean }>;
  createdAtMs: number;
  updatedAtMs: number;
};

export type AdminAlertChannelsResponse = {
  total: number;
  limit: number;
  offset: number;
  channels: AdminAlertChannel[];
};

export type AdminAlertChannelOption = {
  id: string;
  name: string;
  type: AlertChannelType;
  enabled: boolean;
};

export async function getAdminAlertChannels(query?: {
  limit?: number;
  offset?: number;
}): Promise<AdminAlertChannelsResponse> {
  const qs = new URLSearchParams();
  if (query?.limit !== undefined) qs.set("limit", String(query.limit));
  if (query?.offset !== undefined) qs.set("offset", String(query.offset));
  const suffix = qs.size ? `?${qs.toString()}` : "";
  return fetchJson<AdminAlertChannelsResponse>(`/api/admin/alert-channels${suffix}`);
}

export async function getAdminAlertChannelOptions(): Promise<{
  channels: AdminAlertChannelOption[];
}> {
  return fetchJson<{ channels: AdminAlertChannelOption[] }>("/api/admin/alert-channels/options");
}

export async function createAdminAlertChannel(args: {
  name: string;
  type: AlertChannelType;
  enabled?: boolean;
  config: unknown;
}): Promise<{ ok: true; id: string }> {
  return fetchJson<{ ok: true; id: string }>("/api/admin/alert-channels", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function patchAdminAlertChannel(
  channelId: string,
  patch: Partial<{ name: string; enabled: boolean; config: unknown }>,
): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>(`/api/admin/alert-channels/${encodeURIComponent(channelId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteAdminAlertChannel(channelId: string): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>(`/api/admin/alert-channels/${encodeURIComponent(channelId)}`, {
    method: "DELETE",
  });
}

export async function testAdminAlertChannel(channelId: string): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>(
    `/api/admin/alert-channels/${encodeURIComponent(channelId)}/test`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export type AdminAlertRulesResponse = {
  total: number;
  limit: number;
  offset: number;
  rules: AdminAlertRule[];
};

export async function getAdminAlertRules(query?: {
  limit?: number;
  offset?: number;
}): Promise<AdminAlertRulesResponse> {
  const qs = new URLSearchParams();
  if (query?.limit !== undefined) qs.set("limit", String(query.limit));
  if (query?.offset !== undefined) qs.set("offset", String(query.offset));
  const suffix = qs.size ? `?${qs.toString()}` : "";
  return fetchJson<AdminAlertRulesResponse>(`/api/admin/alert-rules${suffix}`);
}

export async function createAdminAlertRule(args: {
  name: string;
  enabled?: boolean;
  severity: AlertSeverity;
  kind: AlertRuleKind;
  selector: unknown;
  params: unknown;
  forMs?: number;
  recoverMs?: number;
  notifyOnRecovery?: boolean;
  channelIds: string[];
}): Promise<{ ok: true; id: string }> {
  return fetchJson<{ ok: true; id: string }>("/api/admin/alert-rules", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function patchAdminAlertRule(
  ruleId: string,
  patch: Partial<{
    name: string;
    enabled: boolean;
    severity: AlertSeverity;
    kind: AlertRuleKind;
    selector: unknown;
    params: unknown;
    forMs: number;
    recoverMs: number;
    notifyOnRecovery: boolean;
    channelIds: string[];
  }>,
): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>(`/api/admin/alert-rules/${encodeURIComponent(ruleId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteAdminAlertRule(ruleId: string): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>(`/api/admin/alert-rules/${encodeURIComponent(ruleId)}`, {
    method: "DELETE",
  });
}

export async function getAdminActiveAlerts(limit?: number): Promise<{
  alerts: Array<{
    rule: { id: string; name: string; severity: string; kind: string };
    agentName: string | null;
    activeSinceMs: number | null;
    lastEvalAtMs: number;
    valueSummary: string | null;
  }>;
}> {
  const qs = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
  return fetchJson<{
    alerts: Array<{
      rule: { id: string; name: string; severity: string; kind: string };
      agentName: string | null;
      activeSinceMs: number | null;
      lastEvalAtMs: number;
      valueSummary: string | null;
    }>;
  }>(`/api/admin/alerts/active${qs}`);
}

export async function getAdminAlertNotifications(args?: {
  status?: string;
  limit?: number;
}): Promise<{
  notifications: Array<{
    id: string;
    kind: string;
    status: string;
    attempts: number;
    lastError: string | null;
    nextAttemptAtMs: number;
    sentAtMs: number | null;
    createdAtMs: number;
    eventTsMs: number;
    rule: { id: string; name: string | null };
    channel: { id: string; name: string | null; type: string | null };
    subjectKey: string;
  }>;
}> {
  const qs = new URLSearchParams();
  if (args?.status) qs.set("status", args.status);
  if (args?.limit) qs.set("limit", String(args.limit));
  const suffix = qs.size ? `?${qs.toString()}` : "";
  return fetchJson<{
    notifications: Array<{
      id: string;
      kind: string;
      status: string;
      attempts: number;
      lastError: string | null;
      nextAttemptAtMs: number;
      sentAtMs: number | null;
      createdAtMs: number;
      eventTsMs: number;
      rule: { id: string; name: string | null };
      channel: { id: string; name: string | null; type: string | null };
      subjectKey: string;
    }>;
  }>(`/api/admin/alert-notifications${suffix}`);
}
