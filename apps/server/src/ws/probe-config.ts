import { eq, inArray } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { agent, probeTask, probeTaskAgent, probeTaskGroup } from "../db/schema";
import type { ProbeConfigBody, ProbeTaskKind, ProbeTaskWire } from "../protocol/envelope";
import { safeJsonParse } from "../util/lang";

function isProbeKind(value: string): value is ProbeTaskKind {
  return value === "icmp" || value === "tcp" || value === "http" || value === "traceroute";
}

type TaskRow = {
  id: string;
  name: string;
  kind: string;
  intervalSec: number;
  timeoutMs: number;
  enabled: boolean;
  targetJson: string;
};

const taskColumns = {
  id: probeTask.id,
  name: probeTask.name,
  kind: probeTask.kind,
  targetJson: probeTask.targetJson,
  intervalSec: probeTask.intervalSec,
  timeoutMs: probeTask.timeoutMs,
  enabled: probeTask.enabled,
};

export async function fetchAllAgentTasks(db: DbClient): Promise<TaskRow[]> {
  return db.select(taskColumns).from(probeTask).where(eq(probeTask.allAgents, true));
}

export type AgentProbeScope = {
  agentId: string;
  groupId: string | null;
};

export async function fetchAgentProbeScopes(
  db: DbClient,
  agentIds: string[],
): Promise<Map<string, AgentProbeScope>> {
  const uniqueAgentIds = [...new Set(agentIds)];
  if (uniqueAgentIds.length === 0) return new Map();

  const rows = await db
    .select({ agentId: agent.id, groupId: agent.groupId })
    .from(agent)
    .where(inArray(agent.id, uniqueAgentIds));

  return new Map(
    rows.map((row) => [
      row.agentId,
      {
        agentId: row.agentId,
        groupId: row.groupId ?? null,
      },
    ]),
  );
}

export async function fetchAgentProbeScope(
  db: DbClient,
  agentId: string,
): Promise<AgentProbeScope | null> {
  return (await fetchAgentProbeScopes(db, [agentId])).get(agentId) ?? null;
}

export type BuildProbeConfigOptions = {
  allAgentTasks?: TaskRow[];
  scope: AgentProbeScope;
  rev: number;
};

export async function buildProbeConfigForAgent(
  db: DbClient,
  agentId: string,
  options: BuildProbeConfigOptions,
): Promise<ProbeConfigBody> {
  const tasksById = new Map<string, TaskRow>();

  const allAgentRows = options.allAgentTasks ?? (await fetchAllAgentTasks(db));

  for (const r of allAgentRows) {
    tasksById.set(r.id, r);
  }

  const agentRows = await db
    .select(taskColumns)
    .from(probeTask)
    .innerJoin(probeTaskAgent, eq(probeTask.id, probeTaskAgent.taskId))
    .where(eq(probeTaskAgent.agentId, agentId));

  for (const r of agentRows) {
    tasksById.set(r.id, r);
  }

  if (options.scope.groupId) {
    const groupRows = await db
      .select(taskColumns)
      .from(probeTask)
      .innerJoin(probeTaskGroup, eq(probeTask.id, probeTaskGroup.taskId))
      .where(eq(probeTaskGroup.groupId, options.scope.groupId));

    for (const r of groupRows) {
      tasksById.set(r.id, r);
    }
  }

  const tasks: ProbeTaskWire[] = [];
  for (const r of tasksById.values()) {
    if (!r.enabled) continue;
    if (typeof r.intervalSec !== "number" || r.intervalSec <= 0) continue;
    if (typeof r.timeoutMs !== "number" || r.timeoutMs <= 0) continue;
    if (!isProbeKind(r.kind)) continue;

    const tar = safeJsonParse(r.targetJson);
    if (tar === null) continue;

    tasks.push({
      id: r.id,
      name: r.name,
      k: r.kind,
      int_s: r.intervalSec,
      to_ms: r.timeoutMs,
      tar,
    });
  }

  return { rev: options.rev, tasks };
}
