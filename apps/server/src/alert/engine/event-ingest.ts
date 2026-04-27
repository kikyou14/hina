import { eq, inArray } from "drizzle-orm";
import type { DbClient } from "../../db/client";
import { agent, agentGroup, probeTask } from "../../db/schema";
import { buildMessage } from "../message/builder";
import { checkCooldown, enqueue, type NotificationJob } from "../repos/notifications-repo";
import { loadChannelsByRuleId, loadEnabledEventRules } from "../repos/rules-repo";
import { RULE_REGISTRY } from "../rules/registry";
import type { RouteChangeEvent } from "../rules/route-change";

export async function ingestRouteChangeEvents(
  db: DbClient,
  changes: RouteChangeEvent[],
): Promise<void> {
  if (changes.length === 0) return;

  const rules = await loadEnabledEventRules(db);
  if (rules.length === 0) return;

  const ruleIds = rules.map((r) => r.id);
  const channelsByRuleId = await loadChannelsByRuleId(db, ruleIds);

  // Load agent + task metadata in batch
  const agentIds = [...new Set(changes.map((c) => c.agentId))];
  const taskIds = [...new Set(changes.map((c) => c.taskId))];

  const agentRows = await db
    .select({ id: agent.id, name: agent.name, groupId: agent.groupId, groupName: agentGroup.name })
    .from(agent)
    .leftJoin(agentGroup, eq(agent.groupId, agentGroup.id))
    .where(inArray(agent.id, agentIds));
  const agentMap = new Map(agentRows.map((a) => [a.id, a]));

  const taskRows = await db
    .select({ id: probeTask.id, name: probeTask.name })
    .from(probeTask)
    .where(inArray(probeTask.id, taskIds));
  const taskNameMap = new Map(taskRows.map((t) => [t.id, t.name]));

  const nowMs = Date.now();

  // Collect all candidate subject keys for batched cooldown check
  const allSubjectKeys = new Set<string>();
  for (const change of changes) {
    allSubjectKeys.add(`a:${change.agentId}|t:${change.taskId}`);
  }

  // Batch cooldown: find ruleId+subjectKey pairs that were recently notified
  const def = RULE_REGISTRY["route_change"];
  if (!def || def.mode !== "event") return;
  const cooldownCutoffMs = nowMs - def.cooldownMs;
  const cooldownSet = await checkCooldown(db, ruleIds, [...allSubjectKeys], cooldownCutoffMs);

  const notificationJobs: NotificationJob[] = [];

  for (const change of changes) {
    const agentInfo = agentMap.get(change.agentId);
    if (!agentInfo) continue;

    for (const rule of rules) {
      const channels = channelsByRuleId.get(rule.id) ?? [];
      if (channels.length === 0) continue;

      const target = def.matchEvent(
        rule,
        change,
        agentInfo,
        taskNameMap.get(change.taskId) ?? null,
      );
      if (!target) continue;

      if (cooldownSet.has(`${rule.id}|${target.subjectKey}`)) continue;

      const msg = buildMessage({
        kind: "firing",
        severity: rule.severity,
        rule: { id: rule.id, name: rule.name, kind: "route_change" },
        subjectKey: target.subjectKey,
        agent: target.agent,
        task: target.task,
        value: target.value,
        tsMs: nowMs,
      });
      const payloadJson = JSON.stringify(msg);

      for (const ch of channels) {
        notificationJobs.push({
          id: crypto.randomUUID(),
          ruleId: rule.id,
          subjectKey: target.subjectKey,
          channelId: ch.id,
          kind: "firing",
          eventTsMs: nowMs,
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

  await enqueue(db, notificationJobs);
}
