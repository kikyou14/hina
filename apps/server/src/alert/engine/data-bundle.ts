import { inArray } from "drizzle-orm";
import type { AgentRegistry } from "../../agents/registry";
import type { DbClient } from "../../db/client";
import { probeResultLatest, probeTask } from "../../db/schema";
import type { RuntimeAgentConfigStore } from "../../settings/runtime";
import type { DataBundle, ProbeLatestRow } from "../rules/types";

const METRICS_STALE_FLOOR_MS = 60_000;
const METRICS_STALE_MULTIPLIER = 10;
const MISSED_HEARTBEAT_FLOOR_MS = 15_000;
const MISSED_HEARTBEAT_MULTIPLIER = 4;

export async function loadDataBundle(
  db: DbClient,
  runtimeAgentConfig: RuntimeAgentConfigStore,
  registry: AgentRegistry,
  probeTaskIds: string[],
  nowMs: number = Date.now(),
): Promise<DataBundle> {
  const runtimeCfg = runtimeAgentConfig.getCurrent();
  const heartbeatWindowMs = runtimeCfg.telemetryIntervalMs + runtimeCfg.telemetryJitterMs;
  const missedHeartbeatGraceMs = Math.max(
    MISSED_HEARTBEAT_FLOOR_MS,
    heartbeatWindowMs * MISSED_HEARTBEAT_MULTIPLIER,
  );
  const metricsStaleMs = Math.max(
    METRICS_STALE_FLOOR_MS,
    heartbeatWindowMs * METRICS_STALE_MULTIPLIER,
  );

  const agents = registry.listForAlert(nowMs);

  const probeLatestByKey = new Map<string, ProbeLatestRow>();
  let probeTaskNameById = new Map<string, string>();

  if (probeTaskIds.length > 0) {
    const latestRows = await db
      .select({
        agentId: probeResultLatest.agentId,
        taskId: probeResultLatest.taskId,
        tsMs: probeResultLatest.tsMs,
        ok: probeResultLatest.ok,
        latMs: probeResultLatest.latMs,
        code: probeResultLatest.code,
        err: probeResultLatest.err,
        updatedAtMs: probeResultLatest.updatedAtMs,
      })
      .from(probeResultLatest)
      .where(inArray(probeResultLatest.taskId, probeTaskIds));

    for (const r of latestRows) {
      probeLatestByKey.set(`a:${r.agentId}|t:${r.taskId}`, {
        agentId: r.agentId,
        taskId: r.taskId,
        tsMs: r.tsMs,
        ok: r.ok,
        latMs: r.latMs ?? null,
        code: r.code ?? null,
        err: r.err ?? null,
        updatedAtMs: r.updatedAtMs,
      });
    }

    const taskNameRows = await db
      .select({ id: probeTask.id, name: probeTask.name })
      .from(probeTask)
      .where(inArray(probeTask.id, probeTaskIds));
    probeTaskNameById = new Map(taskNameRows.map((r) => [r.id, r.name]));
  }

  return {
    agents,
    probeLatestByKey,
    probeTaskNameById,
    metricsStaleMs,
    missedHeartbeatGraceMs,
  };
}
