import type { AdminAlertRule, AlertRuleKind, AlertSeverity } from "@/api/adminAlerts";
import type { ScopeState } from "@/components/ScopeSelector";
import { isRecord } from "@/lib/typeGuards";

export const METRIC_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "cpu.usage_pct", label: "CPU Usage (%)" },
  { key: "mem.used_pct", label: "Memory Usage (%)" },
  { key: "mem.used_bytes", label: "Memory Used" },
  { key: "swap.used_pct", label: "Swap Usage (%)" },
  { key: "disk.used_pct", label: "Disk Usage (%)" },
  { key: "disk.used_bytes", label: "Disk Used" },
  { key: "net.rx_rate", label: "Network RX Rate" },
  { key: "net.tx_rate", label: "Network TX Rate" },
  { key: "load.1", label: "Load (1m)" },
  { key: "load.5", label: "Load (5m)" },
  { key: "load.15", label: "Load (15m)" },
  { key: "proc.count", label: "Process Count" },
  { key: "conn.tcp.count", label: "TCP Connections" },
  { key: "conn.udp.count", label: "UDP Connections" },
  { key: "conn.total.count", label: "Total Connections" },
  { key: "temp.max_c", label: "Max Temperature" },
];

export const CHANNEL_TYPE_BADGE: Record<string, { label: string; className: string }> = {
  telegram: { label: "TG", className: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  email: { label: "EM", className: "bg-orange-500/10 text-orange-600 dark:text-orange-400" },
  webhook: { label: "WH", className: "bg-purple-500/10 text-purple-600 dark:text-purple-400" },
};

export const KIND_KEYS: AlertRuleKind[] = [
  "agent_offline",
  "metric_threshold",
  "probe_failed",
  "probe_latency",
  "quota_exceeded",
  "agent_expiring",
  "route_change",
];

export type ThresholdOp = ">" | "<";
export type MissingMode = "ignore" | "alert";

export const OP_KEYS: ThresholdOp[] = [">", "<"];
export const MAX_DELAY_SEC = 86400;

export type RuleFormState = {
  name: string;
  enabled: boolean;
  severity: AlertSeverity;
  kind: AlertRuleKind;
  forSec: string;
  recoverSec: string;
  notifyOnRecovery: boolean;
  scope: ScopeState;
  channelIds: string[];
  error: string | null;
  metric: string;
  op: ThresholdOp;
  threshold: string;
  missing: MissingMode;
  taskIds: string[];
  quotaPercentage: string;
  daysBeforeExpiry: string;
};

export function mergeRuleFormState(
  prev: RuleFormState,
  patch: Partial<RuleFormState>,
): RuleFormState {
  return { ...prev, ...patch };
}

function initScopeFromSelector(selector: unknown): ScopeState {
  if (!isRecord(selector)) return { mode: "all", groupIds: [], agentIds: [] };
  const obj = selector as Record<string, unknown>;
  const type = obj["type"];

  if (type === "groups" && Array.isArray(obj["groupIds"])) {
    const groupIds = (obj["groupIds"] as unknown[]).filter(
      (v): v is string => typeof v === "string",
    );
    return { mode: "groups", groupIds, agentIds: [] };
  }
  if (type === "agents" && Array.isArray(obj["agentIds"])) {
    const agentIds = (obj["agentIds"] as unknown[]).filter(
      (v): v is string => typeof v === "string",
    );
    return { mode: "specific", groupIds: [], agentIds };
  }
  return { mode: "all", groupIds: [], agentIds: [] };
}

export function initRuleFormState(rule: AdminAlertRule | null): RuleFormState {
  const paramsObj = isRecord(rule?.params) ? (rule!.params as Record<string, unknown>) : {};

  const initTaskIds = Array.isArray(paramsObj["taskIds"])
    ? (paramsObj["taskIds"] as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  return {
    name: rule?.name ?? "",
    enabled: rule?.enabled ?? true,
    severity: (rule?.severity as AlertSeverity) ?? "warning",
    kind: (rule?.kind as AlertRuleKind) ?? "metric_threshold",
    forSec: String(Math.round((rule?.forMs ?? 0) / 1000)),
    recoverSec: String(Math.round((rule?.recoverMs ?? 0) / 1000)),
    notifyOnRecovery: rule?.notifyOnRecovery ?? true,
    scope: initScopeFromSelector(rule?.selector),
    channelIds: rule?.channels.map((c) => c.id) ?? [],
    error: null,
    metric:
      typeof paramsObj["metric"] === "string" ? (paramsObj["metric"] as string) : "cpu.usage_pct",
    op: paramsObj["op"] === "<" ? "<" : ">",
    threshold: typeof paramsObj["value"] === "number" ? String(paramsObj["value"]) : "90",
    missing: paramsObj["missing"] === "alert" ? "alert" : "ignore",
    taskIds: initTaskIds,
    quotaPercentage:
      typeof paramsObj["percentage"] === "number" ? String(paramsObj["percentage"]) : "80",
    daysBeforeExpiry:
      typeof paramsObj["daysBeforeExpiry"] === "number"
        ? String(paramsObj["daysBeforeExpiry"])
        : "7",
  };
}

function isScopeValid(scope: ScopeState): boolean {
  if (scope.mode === "all") return true;
  if (scope.mode === "groups") return scope.groupIds.length > 0;
  return scope.agentIds.length > 0;
}

export function canSubmitRule(state: RuleFormState): boolean {
  if (!state.name.trim() || state.channelIds.length === 0) return false;
  if (!isScopeValid(state.scope)) return false;
  const forVal = Number.parseInt(state.forSec, 10);
  if (Number.isFinite(forVal) && (forVal < 0 || forVal > MAX_DELAY_SEC)) return false;
  const recoverVal = Number.parseInt(state.recoverSec, 10);
  if (Number.isFinite(recoverVal) && (recoverVal < 0 || recoverVal > MAX_DELAY_SEC)) return false;

  if (state.kind === "metric_threshold") {
    if (!state.metric.trim() || !Number.isFinite(Number.parseFloat(state.threshold))) return false;
  } else if (state.kind === "probe_failed" || state.kind === "probe_latency") {
    if (state.taskIds.length === 0) return false;
    if (state.kind === "probe_latency") {
      const v = Number.parseFloat(state.threshold);
      if (!Number.isFinite(v) || v < 0) return false;
    }
  } else if (state.kind === "quota_exceeded") {
    const pct = Number.parseFloat(state.quotaPercentage);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return false;
  } else if (state.kind === "agent_expiring") {
    const days = Number.parseInt(state.daysBeforeExpiry, 10);
    if (!Number.isFinite(days) || days < 1 || days > 365) return false;
  } else if (state.kind === "route_change") {
    if (state.taskIds.length === 0) return false;
  }
  return true;
}

export type RuleFormPayload = {
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
};

function uniqueStrings(input: string[]): string[] {
  return [...new Set(input)];
}

function buildScopeSelector(scope: ScopeState): unknown {
  if (scope.mode === "groups") {
    const groupIds = uniqueStrings(scope.groupIds);
    if (groupIds.length > 0) return { type: "groups", groupIds };
  }
  if (scope.mode === "specific") {
    const agentIds = uniqueStrings(scope.agentIds);
    if (agentIds.length > 0) return { type: "agents", agentIds };
  }
  return { type: "all" };
}

export function buildRulePayload(state: RuleFormState): RuleFormPayload {
  const forRaw = Math.max(0, Number.parseInt(state.forSec, 10) || 0);
  const recoverRaw = Math.max(0, Number.parseInt(state.recoverSec, 10) || 0);
  const forMs = Math.min(forRaw, MAX_DELAY_SEC) * 1000;
  const recoverMs = Math.min(recoverRaw, MAX_DELAY_SEC) * 1000;

  const selector = buildScopeSelector(state.scope);

  let params: unknown = {};
  if (state.kind === "metric_threshold") {
    params = {
      metric: state.metric.trim(),
      op: state.op,
      value: Number.parseFloat(state.threshold),
      missing: state.missing,
    };
  } else if (state.kind === "probe_failed") {
    params = { taskIds: uniqueStrings(state.taskIds) };
  } else if (state.kind === "probe_latency") {
    params = {
      taskIds: uniqueStrings(state.taskIds),
      op: state.op,
      value: Number.parseFloat(state.threshold),
    };
  } else if (state.kind === "quota_exceeded") {
    params = { percentage: Number.parseFloat(state.quotaPercentage) };
  } else if (state.kind === "agent_expiring") {
    params = { daysBeforeExpiry: Number.parseInt(state.daysBeforeExpiry, 10) };
  } else if (state.kind === "route_change") {
    params = { taskIds: uniqueStrings(state.taskIds) };
  }

  const noDelay = state.kind === "agent_expiring" || state.kind === "route_change";

  return {
    name: state.name.trim(),
    enabled: state.enabled,
    severity: state.severity,
    kind: state.kind,
    selector,
    params,
    forMs: noDelay ? 0 : forMs,
    recoverMs: noDelay ? 0 : recoverMs,
    notifyOnRecovery: state.notifyOnRecovery,
    channelIds: uniqueStrings(state.channelIds),
  };
}
