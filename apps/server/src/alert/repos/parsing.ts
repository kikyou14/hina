import type { AlertChannelType, AlertRuleKind, AlertSeverity } from "../types";

export function parseAlertRuleKind(value: unknown): AlertRuleKind | null {
  if (
    value === "agent_offline" ||
    value === "metric_threshold" ||
    value === "probe_failed" ||
    value === "probe_latency" ||
    value === "quota_exceeded" ||
    value === "agent_expiring" ||
    value === "route_change"
  )
    return value;
  return null;
}

export function parseAlertSeverity(value: unknown): AlertSeverity | null {
  if (value === "info" || value === "warning" || value === "critical") return value;
  return null;
}

export function parseAlertChannelType(value: unknown): AlertChannelType | null {
  if (
    value === "webhook" ||
    value === "telegram" ||
    value === "email" ||
    value === "serverchan3" ||
    value === "serverchanturbo" ||
    value === "bark"
  )
    return value;
  return null;
}
