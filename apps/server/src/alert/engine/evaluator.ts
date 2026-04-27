import type { AgentRegistry } from "../../agents/registry";
import type { DbClient } from "../../db/client";
import type { RuntimeAgentConfigStore } from "../../settings/runtime";
import { clampText, safeJsonStringify } from "../../util/lang";
import { MAX_VALUE_JSON_LEN } from "../constants";
import { buildMessage } from "../message/builder";
import type { NotificationJob } from "../repos/notifications-repo";
import type { LoadedChannel } from "../repos/rules-repo";
import { loadChannelsByRuleId, loadEnabledPollRules } from "../repos/rules-repo";
import {
  commitRuleEvaluations,
  loadStatesForRules,
  type RuleEvaluationCommit,
  type TransitionRow,
} from "../repos/state-repo";
import { RULE_REGISTRY } from "../rules/registry";
import type { EvalTarget, LoadedRule, PollRuleDefinition } from "../rules/types";
import { loadDataBundle } from "./data-bundle";
import { advance, type SubjectState } from "./subject-state";

export async function evalTick(deps: {
  db: DbClient;
  runtimeAgentConfig: RuntimeAgentConfigStore;
  registry: AgentRegistry;
}): Promise<void> {
  const nowMs = Date.now();
  const rules = await loadEnabledPollRules(deps.db);
  if (rules.length === 0) return;

  await deps.registry.syncFromDbIfStale();

  const ruleIds = rules.map((r) => r.id);
  const [channelsByRuleId, statesByRuleId] = await Promise.all([
    loadChannelsByRuleId(deps.db, ruleIds),
    loadStatesForRules(deps.db, ruleIds),
  ]);

  const probeTaskIds = new Set<string>();
  for (const rule of rules) {
    const def = RULE_REGISTRY[rule.kind];
    if (!def || def.mode !== "poll") continue;
    const ids = (def as PollRuleDefinition).probeTaskIds?.(rule.params);
    if (ids) for (const id of ids) probeTaskIds.add(id);
  }
  const bundle = await loadDataBundle(
    deps.db,
    deps.runtimeAgentConfig,
    deps.registry,
    [...probeTaskIds],
    nowMs,
  );

  const commits: RuleEvaluationCommit[] = [];

  for (const rule of rules) {
    const def = RULE_REGISTRY[rule.kind];
    if (!def || def.mode !== "poll") continue;
    const pollDef = def as PollRuleDefinition;

    const channels = channelsByRuleId.get(rule.id) ?? [];
    const targets = pollDef.deriveTargets(bundle, rule, nowMs);

    const existingStates = statesByRuleId.get(rule.id) ?? [];
    if (targets.length === 0 && !existingStates.some((s) => s.active)) continue;

    const stateByKey = new Map(existingStates.map((s) => [s.subjectKey, s]));
    const evaluatedKeys = new Set(targets.map((t) => t.subjectKey));

    const transitionRows: TransitionRow[] = [];
    const notificationJobs: NotificationJob[] = [];

    for (const t of targets) {
      const s = stateByKey.get(t.subjectKey);
      const prev = dbRowToState(s);

      const result = advance({
        prev,
        cond: t.cond,
        present: t.present,
        forMs: rule.forMs,
        recoverMs: rule.recoverMs,
        nowMs,
      });

      const valueJson = clampText(safeJsonStringify(t.value) ?? "", MAX_VALUE_JSON_LEN) || null;

      transitionRows.push({
        ruleId: rule.id,
        ruleUpdatedAtMs: rule.updatedAtMs,
        subjectKey: t.subjectKey,
        subjectJson: t.subjectJson,
        next: result.next,
        transition: result.transition,
        valueJson,
        nowMs,
        prevLastFiredAtMs: s?.lastFiredAtMs ?? null,
        prevLastRecoveredAtMs: s?.lastRecoveredAtMs ?? null,
      });

      if (result.transition !== null) {
        enqueueNotifications(notificationJobs, result.transition, rule, t, channels, nowMs);
      }
    }

    for (const s of existingStates) {
      if (evaluatedKeys.has(s.subjectKey)) continue;
      if (!s.active) continue;

      const result = advance({
        prev: dbRowToState(s),
        cond: false,
        present: false,
        forMs: rule.forMs,
        recoverMs: rule.recoverMs,
        nowMs,
      });

      transitionRows.push({
        ruleId: rule.id,
        ruleUpdatedAtMs: rule.updatedAtMs,
        subjectKey: s.subjectKey,
        subjectJson: s.subjectJson,
        next: result.next,
        transition: result.transition,
        valueJson: null,
        nowMs,
        prevLastFiredAtMs: s.lastFiredAtMs,
        prevLastRecoveredAtMs: s.lastRecoveredAtMs,
      });
      // "reset" transitions do NOT enqueue notifications — intentional
    }

    if (transitionRows.length === 0 && notificationJobs.length === 0) continue;

    commits.push({
      ruleId: rule.id,
      ruleUpdatedAtMs: rule.updatedAtMs,
      transitions: transitionRows,
      notifications: notificationJobs,
    });
  }

  await commitRuleEvaluations(deps.db, commits);
}

function dbRowToState(
  row:
    | {
        active: boolean;
        pendingSinceMs: number | null;
        activeSinceMs: number | null;
        recoverSinceMs: number | null;
      }
    | undefined,
): SubjectState | null {
  if (!row) return null;
  if (row.active) {
    return {
      active: true,
      activeSinceMs: row.activeSinceMs ?? 0,
      recoverSinceMs: row.recoverSinceMs,
    };
  }
  return { active: false, pendingSinceMs: row.pendingSinceMs };
}

function enqueueNotifications(
  jobs: NotificationJob[],
  transition: NonNullable<import("./subject-state").Transition>,
  rule: LoadedRule,
  target: EvalTarget,
  channels: LoadedChannel[],
  nowMs: number,
): void {
  if (channels.length === 0) return;

  if (transition.kind === "fire") {
    const msg = buildMessage({
      kind: "firing",
      severity: rule.severity,
      rule: { id: rule.id, name: rule.name, kind: rule.kind },
      subjectKey: target.subjectKey,
      agent: target.agent,
      task: target.task,
      value: target.value,
      tsMs: transition.firedAtMs,
    });
    const payloadJson = JSON.stringify(msg);
    for (const ch of channels) {
      jobs.push({
        id: crypto.randomUUID(),
        ruleId: rule.id,
        subjectKey: target.subjectKey,
        channelId: ch.id,
        kind: "firing",
        eventTsMs: transition.firedAtMs,
        payloadJson,
        status: "pending",
        attempts: 0,
        nextAttemptAtMs: nowMs,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
  }

  if (transition.kind === "recover" && rule.notifyOnRecovery) {
    const msg = buildMessage({
      kind: "recovered",
      severity: rule.severity,
      rule: { id: rule.id, name: rule.name, kind: rule.kind },
      subjectKey: target.subjectKey,
      agent: target.agent,
      task: target.task,
      value: target.value,
      tsMs: transition.recoveredAtMs,
    });
    const payloadJson = JSON.stringify(msg);
    for (const ch of channels) {
      jobs.push({
        id: crypto.randomUUID(),
        ruleId: rule.id,
        subjectKey: target.subjectKey,
        channelId: ch.id,
        kind: "recovered",
        eventTsMs: transition.recoveredAtMs,
        payloadJson,
        status: "pending",
        attempts: 0,
        nextAttemptAtMs: nowMs,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
  }
}
