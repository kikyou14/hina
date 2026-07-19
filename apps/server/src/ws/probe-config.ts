import { eq, inArray } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { agent, agentStatus, probeTask, probeTaskAgent, probeTaskGroup } from "../db/schema";
import type { ProbeConfigBody, ProbeTaskKind, ProbeTaskWire } from "../protocol/envelope";
import { isRecord, safeJsonParse } from "../util/lang";

function isProbeKind(value: string): value is ProbeTaskKind {
  return value === "icmp" || value === "tcp" || value === "http" || value === "traceroute";
}

export function capabilitySupportsTracerouteTcpSizePair(cap: unknown): boolean {
  if (!isRecord(cap)) return false;
  const probes = cap["probes"];
  if (!isRecord(probes)) return false;
  const traceroute = probes["traceroute"];
  if (!isRecord(traceroute)) return false;
  return traceroute["tcpSizePair"] === true;
}

function isTracerouteTcpSizePairTarget(target: unknown): boolean {
  return isRecord(target) && target["protocol"] === "tcp";
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
  supportsTracerouteTcpSizePair?: boolean;
};

export async function buildProbeConfigForAgent(
  db: DbClient,
  agentId: string,
  options: BuildProbeConfigOptions,
): Promise<ProbeConfigBody> {
  const tasksById = new Map<string, TaskRow>();
  const supportsTracerouteTcpSizePair = options.supportsTracerouteTcpSizePair ?? false;

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

    if (
      r.kind === "traceroute" &&
      isTracerouteTcpSizePairTarget(tar) &&
      !supportsTracerouteTcpSizePair
    ) {
      continue;
    }

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

export type TracerouteTcpSupport = {
  targetAgents: number;
  unsupportedAgents: number;
};

type SupportCountTaskRow = {
  id: string;
  kind: string;
  targetJson: string;
  allAgents: boolean;
};

export async function computeTracerouteTcpSupportCounts(
  db: DbClient,
  tasks: SupportCountTaskRow[],
): Promise<Map<string, TracerouteTcpSupport>> {
  const result = new Map<string, TracerouteTcpSupport>();

  const tcpTasks = tasks.filter(
    (t) => t.kind === "traceroute" && isTracerouteTcpSizePairTarget(safeJsonParse(t.targetJson)),
  );
  if (tcpTasks.length === 0) return result;

  const agentRows = await db
    .select({
      id: agent.id,
      groupId: agent.groupId,
      capabilitiesJson: agentStatus.lastCapabilitiesJson,
    })
    .from(agent)
    .leftJoin(agentStatus, eq(agentStatus.agentId, agent.id));

  const supportById = new Map<string, boolean>();
  const agentIdsByGroup = new Map<string, string[]>();
  for (const row of agentRows) {
    supportById.set(
      row.id,
      capabilitySupportsTracerouteTcpSizePair(
        row.capabilitiesJson ? safeJsonParse(row.capabilitiesJson) : null,
      ),
    );
    if (row.groupId) {
      const list = agentIdsByGroup.get(row.groupId) ?? [];
      list.push(row.id);
      agentIdsByGroup.set(row.groupId, list);
    }
  }
  const allAgentIds = agentRows.map((row) => row.id);

  const scopedTaskIds = tcpTasks.filter((t) => !t.allAgents).map((t) => t.id);
  const groupIdsByTask = new Map<string, string[]>();
  const agentIdsByTask = new Map<string, string[]>();
  if (scopedTaskIds.length > 0) {
    const groupRows = await db
      .select({ taskId: probeTaskGroup.taskId, groupId: probeTaskGroup.groupId })
      .from(probeTaskGroup)
      .where(inArray(probeTaskGroup.taskId, scopedTaskIds));
    for (const row of groupRows) {
      const list = groupIdsByTask.get(row.taskId) ?? [];
      list.push(row.groupId);
      groupIdsByTask.set(row.taskId, list);
    }

    const agentLinkRows = await db
      .select({ taskId: probeTaskAgent.taskId, agentId: probeTaskAgent.agentId })
      .from(probeTaskAgent)
      .where(inArray(probeTaskAgent.taskId, scopedTaskIds));
    for (const row of agentLinkRows) {
      const list = agentIdsByTask.get(row.taskId) ?? [];
      list.push(row.agentId);
      agentIdsByTask.set(row.taskId, list);
    }
  }

  for (const task of tcpTasks) {
    const targetIds = new Set<string>();
    if (task.allAgents) {
      for (const id of allAgentIds) targetIds.add(id);
    } else {
      for (const id of agentIdsByTask.get(task.id) ?? []) targetIds.add(id);
      for (const groupId of groupIdsByTask.get(task.id) ?? []) {
        for (const id of agentIdsByGroup.get(groupId) ?? []) targetIds.add(id);
      }
    }

    let unsupportedAgents = 0;
    for (const id of targetIds) {
      if (!supportById.get(id)) unsupportedAgents += 1;
    }
    result.set(task.id, { targetAgents: targetIds.size, unsupportedAgents });
  }

  return result;
}
