import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { alertChannel, alertRule, alertRuleChannel } from "../../db/schema";
import { safeJsonParse } from "../../util/lang";
import type { LoadedRule } from "../rules/types";
import { parseSelector, type AgentSelector } from "../selector";
import type { AlertChannelType } from "../types";
import { parseAlertChannelType, parseAlertRuleKind, parseAlertSeverity } from "./parsing";

export type LoadedChannel = {
  id: string;
  name: string;
  type: AlertChannelType;
  configJson: string;
  enabled: boolean;
};

export async function loadEnabledPollRules(db: DbClient): Promise<LoadedRule[]> {
  const rows = await db
    .select({
      id: alertRule.id,
      name: alertRule.name,
      enabled: alertRule.enabled,
      severity: alertRule.severity,
      kind: alertRule.kind,
      selectorJson: alertRule.selectorJson,
      paramsJson: alertRule.paramsJson,
      forMs: alertRule.forMs,
      recoverMs: alertRule.recoverMs,
      notifyOnRecovery: alertRule.notifyOnRecovery,
      updatedAtMs: alertRule.updatedAtMs,
    })
    .from(alertRule)
    .where(eq(alertRule.enabled, true))
    .orderBy(asc(alertRule.name));

  const out: LoadedRule[] = [];
  for (const r of rows) {
    const kind = parseAlertRuleKind(r.kind);
    if (!kind || kind === "route_change") continue;
    const severity = parseAlertSeverity(r.severity);
    if (!severity) continue;

    const selectorResult = parseSelector(safeJsonParse(r.selectorJson) ?? {});
    const selector: AgentSelector = selectorResult.ok ? selectorResult.value : { type: "all" };
    const params = safeJsonParse(r.paramsJson) ?? {};

    out.push({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      severity,
      kind,
      selector,
      params,
      forMs: Math.min(Math.max(r.forMs, 0), 24 * 60 * 60 * 1000),
      recoverMs: Math.min(Math.max(r.recoverMs, 0), 24 * 60 * 60 * 1000),
      notifyOnRecovery: r.notifyOnRecovery,
      updatedAtMs: r.updatedAtMs,
    });
  }
  return out;
}

export async function loadEnabledEventRules(db: DbClient): Promise<LoadedRule[]> {
  const rows = await db
    .select({
      id: alertRule.id,
      name: alertRule.name,
      enabled: alertRule.enabled,
      severity: alertRule.severity,
      kind: alertRule.kind,
      selectorJson: alertRule.selectorJson,
      paramsJson: alertRule.paramsJson,
      forMs: alertRule.forMs,
      recoverMs: alertRule.recoverMs,
      notifyOnRecovery: alertRule.notifyOnRecovery,
      updatedAtMs: alertRule.updatedAtMs,
    })
    .from(alertRule)
    .where(and(eq(alertRule.enabled, true), eq(alertRule.kind, "route_change")))
    .orderBy(asc(alertRule.name));

  const out: LoadedRule[] = [];
  for (const r of rows) {
    const severity = parseAlertSeverity(r.severity);
    if (!severity) continue;
    const selectorResult = parseSelector(safeJsonParse(r.selectorJson) ?? {});
    const selector: AgentSelector = selectorResult.ok ? selectorResult.value : { type: "all" };
    const params = safeJsonParse(r.paramsJson) ?? {};

    out.push({
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      severity,
      kind: "route_change",
      selector,
      params,
      forMs: 0,
      recoverMs: 0,
      notifyOnRecovery: false,
      updatedAtMs: r.updatedAtMs,
    });
  }
  return out;
}

export async function loadChannelsByRuleId(
  db: DbClient,
  ruleIds: string[],
): Promise<Map<string, LoadedChannel[]>> {
  const out = new Map<string, LoadedChannel[]>();
  if (ruleIds.length === 0) return out;

  const rows = await db
    .select({
      ruleId: alertRuleChannel.ruleId,
      channelId: alertChannel.id,
      channelName: alertChannel.name,
      channelType: alertChannel.type,
      channelEnabled: alertChannel.enabled,
      configJson: alertChannel.configJson,
    })
    .from(alertRuleChannel)
    .innerJoin(alertChannel, eq(alertRuleChannel.channelId, alertChannel.id))
    .where(inArray(alertRuleChannel.ruleId, ruleIds))
    .orderBy(asc(alertChannel.name));

  for (const row of rows) {
    if (!row.channelEnabled) continue;
    const type = parseAlertChannelType(row.channelType);
    if (!type) continue;

    const list = out.get(row.ruleId) ?? [];
    list.push({
      id: row.channelId,
      name: row.channelName,
      type,
      configJson: row.configJson,
      enabled: row.channelEnabled,
    });
    out.set(row.ruleId, list);
  }
  return out;
}
