import { and, asc, eq, gte, isNotNull, lt, lte, or } from "drizzle-orm";
import type { AppContext } from "../app";
import {
  agent,
  probeResult,
  probeResultDaily,
  probeResultHourly,
  probeResultLatest,
  probeTask,
  probeTaskAgent,
  probeTaskGroup,
} from "../db/schema";
import {
  anonymizeTracerouteExtraForPublic,
  sanitizeTracerouteExtraRawJsonForPublic,
} from "../util/traceroute-privacy";
import type { ProbeSeriesTier } from "./helpers";

type Db = AppContext["Variables"]["db"];

export async function resolveVisibleTask(
  db: Db,
  taskId: string,
  agentId: string,
): Promise<{ kind: string } | null> {
  const rows = await db
    .select({ kind: probeTask.kind })
    .from(probeTask)
    .leftJoin(
      probeTaskAgent,
      and(eq(probeTaskAgent.taskId, probeTask.id), eq(probeTaskAgent.agentId, agentId)),
    )
    .leftJoin(agent, eq(agent.id, agentId))
    .leftJoin(
      probeTaskGroup,
      and(eq(probeTaskGroup.taskId, probeTask.id), eq(probeTaskGroup.groupId, agent.groupId)),
    )
    .where(
      and(
        eq(probeTask.id, taskId),
        eq(probeTask.enabled, true),
        or(
          eq(probeTask.allAgents, true),
          isNotNull(probeTaskAgent.taskId),
          isNotNull(probeTaskGroup.taskId),
        ),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

export async function queryProbeLatest(db: Db, agentId: string) {
  return db
    .select({
      taskId: probeResultLatest.taskId,
      tsMs: probeResultLatest.tsMs,
      recvTsMs: probeResultLatest.recvTsMs,
      ok: probeResultLatest.ok,
      latMs: probeResultLatest.latMs,
      code: probeResultLatest.code,
      extraJson: probeResultLatest.extraJson,
      lossPct: probeResultLatest.lossPct,
      jitterMs: probeResultLatest.jitterMs,
      updatedAtMs: probeResultLatest.updatedAtMs,
      taskName: probeTask.name,
      taskKind: probeTask.kind,
      taskEnabled: probeTask.enabled,
      taskTraceRevealHopDetails: probeTask.traceRevealHopDetails,
      taskIntervalSec: probeTask.intervalSec,
      taskUpdatedAtMs: probeTask.updatedAtMs,
    })
    .from(probeResultLatest)
    .innerJoin(probeTask, eq(probeResultLatest.taskId, probeTask.id))
    .leftJoin(
      probeTaskAgent,
      and(eq(probeTaskAgent.taskId, probeResultLatest.taskId), eq(probeTaskAgent.agentId, agentId)),
    )
    .leftJoin(agent, eq(agent.id, agentId))
    .leftJoin(
      probeTaskGroup,
      and(
        eq(probeTaskGroup.taskId, probeResultLatest.taskId),
        eq(probeTaskGroup.groupId, agent.groupId),
      ),
    )
    .where(
      and(
        eq(probeResultLatest.agentId, agentId),
        eq(probeTask.enabled, true),
        or(
          eq(probeTask.allAgents, true),
          isNotNull(probeTaskAgent.taskId),
          isNotNull(probeTaskGroup.taskId),
        ),
      ),
    )
    .orderBy(asc(probeTask.name));
}

export type ProbeLatestPrivacy = "anonymized" | "full";

type ProbeLatestRow = Awaited<ReturnType<typeof queryProbeLatest>>[number];

export function formatProbeLatestResults(rows: ProbeLatestRow[], privacy: ProbeLatestPrivacy) {
  return rows.map((r) => {
    let extra: unknown = null;
    let extraParseError = false;
    let extraRawJson: string | null = null;

    if (r.taskKind === "traceroute" && r.extraJson) {
      const revealHopDetails = r.taskTraceRevealHopDetails === true;
      if (privacy === "full") {
        try {
          extra = JSON.parse(r.extraJson);
        } catch {
          extraParseError = true;
          extraRawJson = r.extraJson;
        }
      } else {
        try {
          const parsed = JSON.parse(r.extraJson);
          extra = anonymizeTracerouteExtraForPublic(parsed, { revealHopDetails });
        } catch {
          extraParseError = true;
          extraRawJson = sanitizeTracerouteExtraRawJsonForPublic(r.extraJson, {
            revealHopDetails,
          });
        }
      }
    }

    return {
      task: {
        id: r.taskId,
        name: r.taskName,
        kind: r.taskKind ?? null,
        enabled: r.taskEnabled,
        intervalSec: r.taskIntervalSec,
        updatedAtMs: r.taskUpdatedAtMs,
      },
      latest: {
        tsMs: r.tsMs,
        recvTsMs: r.recvTsMs,
        ok: r.ok,
        latMs: r.latMs ?? null,
        code: r.code ?? null,
        err: null,
        extra,
        extraParseError,
        extraRawJson,
        lossPct: r.lossPct ?? null,
        jitterMs: r.jitterMs ?? null,
        updatedAtMs: r.updatedAtMs,
      },
    };
  });
}

function formatRollupPoint(r: {
  bucketStartMs: number;
  samples: number;
  okSamples: number;
  latSamples: number;
  latSumMs: number;
  latMinMs: number | null;
  latMaxMs: number | null;
  lossSamples: number;
  lossSumPct: number;
  lossMaxPct: number | null;
  jitSamples: number;
  jitSumMs: number;
  jitMaxMs: number | null;
}) {
  return {
    t: r.bucketStartMs,
    samples: r.samples,
    okSamples: r.okSamples,
    latSamples: r.latSamples,
    latAvgMs: r.latSamples > 0 ? Math.round(r.latSumMs / r.latSamples) : null,
    latMinMs: r.latMinMs ?? null,
    latMaxMs: r.latMaxMs ?? null,
    lossSamples: r.lossSamples,
    lossAvgPct: r.lossSamples > 0 ? r.lossSumPct / r.lossSamples : null,
    lossMaxPct: r.lossMaxPct ?? null,
    jitSamples: r.jitSamples,
    jitAvgMs: r.jitSamples > 0 ? r.jitSumMs / r.jitSamples : null,
    jitMaxMs: r.jitMaxMs ?? null,
  };
}

function resolveTier(
  requestedTier: ProbeSeriesTier,
  spanMs: number,
): Exclude<ProbeSeriesTier, "auto"> {
  if (requestedTier !== "auto") return requestedTier;
  if (spanMs <= 24 * 60 * 60 * 1000) return "raw";
  if (spanMs <= 90 * 24 * 60 * 60 * 1000) return "hourly";
  return "daily";
}

export type ProbeSeriesParams = {
  agentId: string;
  taskId: string;
  fromMs: number;
  toMs: number;
  maxPoints: number;
  requestedTier: ProbeSeriesTier;
};

export async function queryProbeResultSeries(db: Db, params: ProbeSeriesParams) {
  const { agentId, taskId, fromMs, toMs, maxPoints, requestedTier } = params;
  const tier = resolveTier(requestedTier, toMs - fromMs);

  if (tier === "raw") {
    const rows = await db
      .select({
        tsMs: probeResult.tsMs,
        ok: probeResult.ok,
        latMs: probeResult.latMs,
        lossPct: probeResult.lossPct,
        jitterMs: probeResult.jitterMs,
      })
      .from(probeResult)
      .where(
        and(
          eq(probeResult.agentId, agentId),
          eq(probeResult.taskId, taskId),
          gte(probeResult.tsMs, fromMs),
          lt(probeResult.tsMs, toMs),
        ),
      )
      .orderBy(asc(probeResult.tsMs), asc(probeResult.id))
      .limit(maxPoints + 1);

    if (rows.length > maxPoints) {
      return {
        status: 400 as const,
        body: { ok: false as const, code: "too_many_points", maxPoints },
      };
    }

    return {
      status: 200 as const,
      body: {
        ok: true as const,
        tier,
        intervalSec: null as number | null,
        agentId,
        taskId,
        fromMs,
        toMs,
        maxPoints,
        points: rows.map((r) => ({
          t: r.tsMs,
          ok: r.ok,
          latMs: r.latMs ?? null,
          lossPct: r.lossPct ?? null,
          jitterMs: r.jitterMs ?? null,
        })),
      },
    };
  }

  const isHourly = tier === "hourly";
  const intervalSec = isHourly ? 3600 : 86400;
  const intervalMs = intervalSec * 1000;
  const bucketFrom = Math.floor(fromMs / intervalMs) * intervalMs;
  const bucketTo = Math.floor((toMs - 1) / intervalMs) * intervalMs;
  const table = isHourly ? probeResultHourly : probeResultDaily;

  const rows = await db
    .select({
      bucketStartMs: table.bucketStartMs,
      samples: table.samples,
      okSamples: table.okSamples,
      latSamples: table.latSamples,
      latSumMs: table.latSumMs,
      latMinMs: table.latMinMs,
      latMaxMs: table.latMaxMs,
      lossSamples: table.lossSamples,
      lossSumPct: table.lossSumPct,
      lossMaxPct: table.lossMaxPct,
      jitSamples: table.jitSamples,
      jitSumMs: table.jitSumMs,
      jitMaxMs: table.jitMaxMs,
    })
    .from(table)
    .where(
      and(
        eq(table.agentId, agentId),
        eq(table.taskId, taskId),
        gte(table.bucketStartMs, bucketFrom),
        lte(table.bucketStartMs, bucketTo),
      ),
    )
    .orderBy(asc(table.bucketStartMs))
    .limit(maxPoints + 1);

  if (rows.length > maxPoints) {
    return {
      status: 400 as const,
      body: { ok: false as const, code: "too_many_points", maxPoints },
    };
  }

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      tier,
      intervalSec,
      agentId,
      taskId,
      fromMs,
      toMs,
      maxPoints,
      points: rows.map(formatRollupPoint),
    },
  };
}
