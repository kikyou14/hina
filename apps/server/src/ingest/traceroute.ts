import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DbTx } from "../db/client";
import { probeResultLatest, probeTask, routeChangeState } from "../db/schema";
import type { AsnLookup } from "../geo/asn";
import { isRecord } from "../util/lang";
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
  type RouteObservation,
  type TraceLike,
  type TracerouteLike,
} from "./traceroute-route";
import { clampText, safeJsonStringify, TRACEROUTE_EXTRA_JSON_MAX_BYTES } from "./util";

function enrichHopsAsn(hops: unknown[], asnLookup: AsnLookup): boolean {
  let modified = false;

  for (const hop of hops as HopLike[]) {
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

  return modified;
}

function enrichDestinationAsn(obj: TracerouteLike, asnLookup: AsnLookup): boolean {
  if (
    (obj.destination_asn_info !== null && obj.destination_asn_info !== undefined) ||
    typeof obj.target_ip !== "string"
  ) {
    return false;
  }

  const info = asnLookup.lookup(obj.target_ip);
  if (!info) return false;

  obj.destination_asn_info = {
    asn: info.asn,
    prefix: "",
    country_code: "",
    registry: "",
    name: info.name,
  };
  return true;
}

export function enrichTracerouteAsn(extraJson: string, asnLookup: AsnLookup): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extraJson);
  } catch {
    return extraJson;
  }

  if (!isRecord(parsed)) return extraJson;
  const obj = parsed as TracerouteLike;
  if (obj.kind !== "traceroute") return extraJson;

  let modified = false;

  if (obj.v === 2 && Array.isArray(obj.traces)) {
    for (const trace of obj.traces) {
      if (!isRecord(trace)) continue;
      const t = trace as TraceLike;
      if (!Array.isArray(t.hops)) continue;
      if (enrichHopsAsn(t.hops, asnLookup)) modified = true;
    }
  } else if (Array.isArray(obj.hops)) {
    if (enrichHopsAsn(obj.hops, asnLookup)) modified = true;
  }

  if (enrichDestinationAsn(obj, asnLookup)) modified = true;

  return modified ? JSON.stringify(parsed) : extraJson;
}

function detectTracerouteResultVersion(x: unknown): number {
  if (isRecord(x) && typeof x["v"] === "number" && Number.isFinite(x["v"])) return x["v"];
  return 2;
}

export function buildTracerouteResultExtraJson(
  x: unknown,
  asnLookup: AsnLookup | null,
): string | null {
  if (x === undefined) return null;

  const json = safeJsonStringify(x);
  if (json === null) return null;

  const enriched = asnLookup ? enrichTracerouteAsn(json, asnLookup) : json;
  if (Buffer.byteLength(enriched, "utf8") <= TRACEROUTE_EXTRA_JSON_MAX_BYTES) return enriched;

  return JSON.stringify({
    kind: "traceroute",
    v: detectTracerouteResultVersion(x),
    error_code: "result_too_large",
  });
}

export type RouteChangeEvent = {
  agentId: string;
  taskId: string;
  signature: string;
  prevSignature: string;
};

const ROUTE_STATE_CHUNK_SIZE = 300;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export type PreparedTracerouteResult = {
  agentId: string;
  taskId: string;
  tsMs: number;
  recvTsMs: number;
  ok: boolean;
  latMs: number | null;
  code: number | null;
  err: string | null;
  extraJson: string | null;
  lossPct: number | null;
  jitterMs: number | null;
  observation: RouteObservation | null;
};

export function prepareTracerouteResults(
  batch: ProbeResultIngestArgs[],
  asnLookup: AsnLookup | null,
): PreparedTracerouteResult[] {
  if (batch.length === 0) return [];

  const latestByKey = new Map<string, ProbeResultIngestArgs>();
  for (const args of batch) {
    const key = `${args.agentId}\0${args.result.tid}`;
    const existing = latestByKey.get(key);
    if (!existing || args.result.ts > existing.result.ts) {
      latestByKey.set(key, args);
    }
  }

  const prepared: PreparedTracerouteResult[] = [];
  for (const args of latestByKey.values()) {
    const r = args.result;
    const extraJson = buildTracerouteResultExtraJson(r.x, asnLookup);
    prepared.push({
      agentId: args.agentId,
      taskId: r.tid,
      tsMs: r.ts,
      recvTsMs: args.recvTsMs,
      ok: r.ok,
      latMs: r.lat_ms ?? null,
      code: r.code ?? null,
      err: clampText(r.err, 4096),
      extraJson,
      lossPct: r.loss ?? null,
      jitterMs: r.jit_ms ?? null,
      observation: extractRouteObservation(extraJson),
    });
  }
  return prepared;
}

export async function ingestTracerouteResultsBatch(
  tx: DbTx,
  prepared: PreparedTracerouteResult[],
): Promise<RouteChangeEvent[]> {
  if (prepared.length === 0) return [];

  const taskIds = [...new Set(prepared.map((p) => p.taskId))];
  const taskIntervalMap = await loadTaskIntervals(tx, taskIds);

  const stateKeys = prepared.map((p) => ({ agentId: p.agentId, taskId: p.taskId }));
  const stateMap = await batchLoadRouteStates(tx, stateKeys);

  const changes: RouteChangeEvent[] = [];
  const stateUpdates: Array<{ agentId: string; taskId: string; state: RouteState; nowMs: number }> =
    [];

  for (const p of prepared) {
    const nowMs = p.recvTsMs;

    await tx
      .insert(probeResultLatest)
      .values({
        agentId: p.agentId,
        taskId: p.taskId,
        tsMs: p.tsMs,
        recvTsMs: nowMs,
        ok: p.ok,
        latMs: p.latMs,
        code: p.code,
        err: p.err,
        extraJson: p.extraJson,
        lossPct: p.lossPct,
        jitterMs: p.jitterMs,
        routeObservationSignature: p.observation?.signature ?? null,
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

    const observation = p.observation;
    if (!observation) continue;

    const stateKey = `${p.agentId}\0${p.taskId}`;
    const prevState = stateMap.get(stateKey) ?? emptyRouteState();
    const policy = buildRouteChangePolicy(taskIntervalMap.get(p.taskId) ?? null);

    const result = advanceRouteChangeState(
      prevState,
      { signature: observation.signature, quality: observation.quality, tsMs: p.tsMs },
      policy,
    );

    stateUpdates.push({ agentId: p.agentId, taskId: p.taskId, state: result.state, nowMs });

    if (result.emit) {
      changes.push({
        agentId: p.agentId,
        taskId: p.taskId,
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

  for (const group of chunk(keys, ROUTE_STATE_CHUNK_SIZE)) {
    const conditions = group.map((k) =>
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
  }

  return result;
}

async function batchSaveRouteStates(
  tx: DbTx,
  updates: Array<{ agentId: string; taskId: string; state: RouteState; nowMs: number }>,
): Promise<void> {
  for (const group of chunk(updates, ROUTE_STATE_CHUNK_SIZE)) {
    const values = group.map((u) => ({
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
}

async function loadTaskIntervals(tx: DbTx, taskIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const group of chunk(taskIds, ROUTE_STATE_CHUNK_SIZE)) {
    const rows = await tx
      .select({ id: probeTask.id, intervalSec: probeTask.intervalSec })
      .from(probeTask)
      .where(inArray(probeTask.id, group));
    for (const r of rows) map.set(r.id, r.intervalSec);
  }
  return map;
}
