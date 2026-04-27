import type { AlertRuleKind } from "../types";
import { agentExpiringRule } from "./agent-expiring";
import { agentOfflineRule } from "./agent-offline";
import { metricThresholdRule } from "./metric-threshold";
import { probeFailedRule } from "./probe-failed";
import { probeLatencyRule } from "./probe-latency";
import { quotaExceededRule } from "./quota-exceeded";
import { routeChangeRule } from "./route-change";
import type { RuleDefinition } from "./types";

export const RULE_REGISTRY: Record<AlertRuleKind, RuleDefinition> = {
  agent_offline: agentOfflineRule,
  metric_threshold: metricThresholdRule,
  probe_failed: probeFailedRule,
  probe_latency: probeLatencyRule,
  quota_exceeded: quotaExceededRule,
  agent_expiring: agentExpiringRule,
  route_change: routeChangeRule,
};

export function resolveRule(kind: string): RuleDefinition | undefined {
  return RULE_REGISTRY[kind as AlertRuleKind];
}
