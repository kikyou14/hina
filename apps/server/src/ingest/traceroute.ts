import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DbTx } from "../db/client";
import { probeResultLatest, probeTask, routeChangeState } from "../db/schema";
import type { AsnLookup } from "../geo/asn";
import type { ProbeResultIngestArgs } from "./probe";
import {
  advanceRouteChangeState,
  buildRouteChangePolicy,
  emptyRouteState,
  type RouteState,
} from "./route-change-state";
import {
  extractRouteObservation,
  type HopLike,
  type ResponseLike,
  type TracerouteLike,
} from "./traceroute-route";
import { clampText, safeJsonStringify } from "./util";

function enrichTracerouteAsn(extraJson: string, asnLookup: AsnLookup): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extraJson);
  } catch {
    return extraJson;
  }

  if (typeof parsed !== "object" || parsed === null) return extraJson;
  const obj = parsed as TracerouteLike;
  if (obj.kind !== "traceroute" || !Array.isArray(obj.hops)) return extraJson;

  let modified = false;

  for (const hop of obj.hops as HopLike[]) {
    if (typeof hop !== "object" || hop === null) continue;
    if (!Array.isArray(hop.responses)) continue;

    for (const resp of hop.responses as ResponseLike[]) {
      if (typeof resp !== "object" || resp === null) continue;
      if (typeof resp.ip !== "string" || (resp.asn_info !== null && resp.asn_info !== undefined))
        continue;
      const info = asnLookup.lookup(resp.ip);
      if (info) {
        resp.asn_info = {
          asn: info.asn,
          prefix: "",
          country_code: "",
          registry: "",
          name: info.name,
        };
        modified = true;
      }
    }
  }

  if (
    (obj.destination_asn_info === null || obj.destination_asn_info === undefined) &&
    typeof obj.target_ip === "string"
  ) {
    const info = asnLookup.lookup(obj.target_ip);
    if (info) {
      obj.destination_asn_info = {
        asn: info.asn,
        prefix: "",
        country_code: "",
        registry: "",
        name: info.name,
      };
      modified = true;
    }
  }

  return modified ? JSON.stringify(parsed) : extraJson;
}

export type RouteChangeEvent = {
  agentId: string;
  taskId: string;
  signature: string;
  prevSignature: string;
};

export async function ingestTracerouteResultsBatch(
  tx: DbTx,
  batch: ProbeResultIngestArgs[],
  asnLookup: AsnLookup | null,
): Promise<RouteChangeEvent[]> {
  if (batch.length === 0) return [];

  const latestByKey = new Map<string, ProbeResultIngestArgs>();
  for (const args of batch) {
    const key = `${args.agentId}\0${args.result.tid}`;
    const existing = latestByKey.get(key);
    if (!existing || args.result.ts > existing.result.ts) {
      latestByKey.set(key, args);
    }
  }

  const taskIds = [...new Set([...latestByKey.values()].map((a) => a.result.tid))];
  const taskIntervalMap = await loadTaskIntervals(tx, taskIds);

  const stateKeys = [...latestByKey.values()].map((a) => ({
    agentId: a.agentId,
    taskId: a.result.tid,
  }));
  const stateMap = await batchLoadRouteStates(tx, stateKeys);

  const changes: RouteChangeEvent[] = [];
  const stateUpdates: Array<{ agentId: string; taskId: string; state: RouteState; nowMs: number }> =
    [];

  for (const args of latestByKey.values()) {
    const r = args.result;
    const nowMs = args.recvTsMs;
    const err = clampText(r.err, 4096);
    let extraJson =
      r.x === undefined ? null : clampText(safeJsonStringify(r.x) ?? undefined, 32_768);
    if (asnLookup && extraJson) {
      extraJson = enrichTracerouteAsn(extraJson, asnLookup);
    }

    const observation = extractRouteObservation(extraJson);
    const signature = observation?.signature ?? null;

    await tx
      .insert(probeResultLatest)
      .values({
        agentId: args.agentId,
        taskId: r.tid,
        tsMs: r.ts,
        recvTsMs: nowMs,
        ok: r.ok,
        latMs: r.lat_ms ?? null,
        code: r.code ?? null,
        err,
        extraJson,
        lossPct: r.loss ?? null,
        jitterMs: r.jit_ms ?? null,
        routeObservationSignature: signature,
        updatedAtMs: nowMs,
      })
      .onConflictDoUpdate({
        target: [probeResultLatest.agentId, probeResultLatest.taskId],
        set: {
          tsMs: sql`excluded.ts_ms`,
          recvTsMs: sql`excluded.recv_ts_ms`,
          ok: sql`excluded.ok`,
          latMs: sql`excluded.lat_ms`,
          code: sql`excluded.code`,
          err: sql`excluded.err`,
          extraJson: sql`excluded.extra_json`,
          lossPct: sql`excluded.loss_pct`,
          jitterMs: sql`excluded.jitter_ms`,
          routeObservationSignature: sql`excluded.route_observation_signature`,
          updatedAtMs: sql`excluded.updated_at_ms`,
        },
        setWhere: sql`excluded.ts_ms >= ${probeResultLatest.tsMs}`,
      });

    if (!observation) continue;

    const stateKey = `${args.agentId}\0${r.tid}`;
    const prevState = stateMap.get(stateKey) ?? emptyRouteState();
    const policy = buildRouteChangePolicy(taskIntervalMap.get(r.tid) ?? null);

    const result = advanceRouteChangeState(
      prevState,
      { signature: observation.signature, quality: observation.quality, tsMs: r.ts },
      policy,
    );

    stateUpdates.push({ agentId: args.agentId, taskId: r.tid, state: result.state, nowMs });

    if (result.emit) {
      changes.push({
        agentId: args.agentId,
        taskId: r.tid,
        signature: result.emit.signature,
        prevSignature: result.emit.prevSignature,
      });
    }
  }

  await batchSaveRouteStates(tx, stateUpdates);

  return changes;
}

function routeStateKey(agentId: string, taskId: string): string {
  return `${agentId}\0${taskId}`;
}

async function batchLoadRouteStates(
  tx: DbTx,
  keys: Array<{ agentId: string; taskId: string }>,
): Promise<Map<string, RouteState>> {
  const result = new Map<string, RouteState>();
  if (keys.length === 0) return result;

  const conditions = keys.map((k) =>
    and(eq(routeChangeState.agentId, k.agentId), eq(routeChangeState.taskId, k.taskId)),
  );

  const rows = await tx
    .select()
    .from(routeChangeState)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions));

  for (const row of rows) {
    result.set(routeStateKey(row.agentId, row.taskId), {
      stableSignature: row.stableSignature,
      stableObservedAtMs: row.stableObservedAtMs,
      candidateSignature: row.candidateSignature,
      candidateFirstSeenAtMs: row.candidateFirstSeenAtMs,
      candidateLastSeenAtMs: row.candidateLastSeenAtMs,
      candidateSeenCount: row.candidateSeenCount,
      candidateStrongSeenCount: row.candidateStrongSeenCount,
      lastObservationTsMs: row.lastObservationTsMs,
    });
  }

  return result;
}

async function batchSaveRouteStates(
  tx: DbTx,
  updates: Array<{ agentId: string; taskId: string; state: RouteState; nowMs: number }>,
): Promise<void> {
  if (updates.length === 0) return;

  const values = updates.map((u) => ({
    agentId: u.agentId,
    taskId: u.taskId,
    stableSignature: u.state.stableSignature,
    stableObservedAtMs: u.state.stableObservedAtMs,
    candidateSignature: u.state.candidateSignature,
    candidateFirstSeenAtMs: u.state.candidateFirstSeenAtMs,
    candidateLastSeenAtMs: u.state.candidateLastSeenAtMs,
    candidateSeenCount: u.state.candidateSeenCount,
    candidateStrongSeenCount: u.state.candidateStrongSeenCount,
    lastObservationTsMs: u.state.lastObservationTsMs,
    updatedAtMs: u.nowMs,
  }));

  await tx
    .insert(routeChangeState)
    .values(values)
    .onConflictDoUpdate({
      target: [routeChangeState.agentId, routeChangeState.taskId],
      set: {
        stableSignature: sql`excluded.stable_signature`,
        stableObservedAtMs: sql`excluded.stable_observed_at_ms`,
        candidateSignature: sql`excluded.candidate_signature`,
        candidateFirstSeenAtMs: sql`excluded.candidate_first_seen_at_ms`,
        candidateLastSeenAtMs: sql`excluded.candidate_last_seen_at_ms`,
        candidateSeenCount: sql`excluded.candidate_seen_count`,
        candidateStrongSeenCount: sql`excluded.candidate_strong_seen_count`,
        lastObservationTsMs: sql`excluded.last_observation_ts_ms`,
        updatedAtMs: sql`excluded.updated_at_ms`,
      },
    });
}

async function loadTaskIntervals(tx: DbTx, taskIds: string[]): Promise<Map<string, number>> {
  if (taskIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: probeTask.id, intervalSec: probeTask.intervalSec })
    .from(probeTask)
    .where(inArray(probeTask.id, taskIds));
  return new Map(rows.map((r) => [r.id, r.intervalSec]));
}
