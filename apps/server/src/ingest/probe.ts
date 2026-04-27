import { sql } from "drizzle-orm";
import type { DbTx } from "../db/client";
import { probeResult, probeResultLatest } from "../db/schema";
import type { ProbeResultBody } from "../protocol/envelope";
import { clampText, safeJsonStringify } from "./util";

export type ProbeResultIngestArgs = {
  agentId: string;
  recvTsMs: number;
  result: ProbeResultBody;
};

const PROBE_RESULT_INSERT_CHUNK_SIZE = 80;

export async function ingestProbeResultsBatch(
  tx: DbTx,
  batch: ProbeResultIngestArgs[],
): Promise<void> {
  if (batch.length === 0) return;

  for (let i = 0; i < batch.length; i += PROBE_RESULT_INSERT_CHUNK_SIZE) {
    const chunk = batch.slice(i, i + PROBE_RESULT_INSERT_CHUNK_SIZE);

    const rows = chunk.map((args) => {
      const r = args.result;
      const nowMs = args.recvTsMs;

      const err = clampText(r.err, 4096);
      const extraJson =
        r.x === undefined ? null : clampText(safeJsonStringify(r.x) ?? undefined, 32_768);

      const latMs = r.lat_ms === undefined ? null : r.lat_ms;
      const code = r.code === undefined ? null : r.code;
      const lossPct = r.loss === undefined ? null : r.loss;
      const jitterMs = r.jit_ms === undefined ? null : r.jit_ms;

      return {
        agentId: args.agentId,
        taskId: r.tid,
        tsMs: r.ts,
        recvTsMs: nowMs,
        ok: r.ok,
        latMs,
        code,
        err,
        extraJson,
        lossPct,
        jitterMs,
        createdAtMs: nowMs,
      };
    });

    await tx.insert(probeResult).values(rows);

    const latestByKey = new Map<
      string,
      {
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
        updatedAtMs: number;
      }
    >();

    for (const row of rows) {
      const key = `${row.agentId}\u0000${row.taskId}`;
      const existing = latestByKey.get(key);
      if (
        !existing ||
        row.tsMs > existing.tsMs ||
        (row.tsMs === existing.tsMs && row.recvTsMs > existing.recvTsMs)
      ) {
        latestByKey.set(key, {
          agentId: row.agentId,
          taskId: row.taskId,
          tsMs: row.tsMs,
          recvTsMs: row.recvTsMs,
          ok: row.ok,
          latMs: row.latMs,
          code: row.code,
          err: row.err,
          extraJson: row.extraJson,
          lossPct: row.lossPct,
          jitterMs: row.jitterMs,
          updatedAtMs: row.recvTsMs,
        });
      }
    }

    const latestRows = [...latestByKey.values()];
    if (latestRows.length === 0) continue;

    await tx
      .insert(probeResultLatest)
      .values(latestRows)
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
          updatedAtMs: sql`excluded.updated_at_ms`,
        },
        setWhere: sql`excluded.ts_ms >= ${probeResultLatest.tsMs}`,
      });
  }
}

export async function ingestProbeResult(tx: DbTx, args: ProbeResultIngestArgs): Promise<void> {
  const r = args.result;
  const nowMs = args.recvTsMs;

  const err = clampText(r.err, 4096);
  const extraJson =
    r.x === undefined ? null : clampText(safeJsonStringify(r.x) ?? undefined, 32_768);

  const latMs = r.lat_ms === undefined ? null : r.lat_ms;
  const code = r.code === undefined ? null : r.code;
  const lossPct = r.loss === undefined ? null : r.loss;
  const jitterMs = r.jit_ms === undefined ? null : r.jit_ms;

  await tx.insert(probeResult).values({
    agentId: args.agentId,
    taskId: r.tid,
    tsMs: r.ts,
    recvTsMs: nowMs,
    ok: r.ok,
    latMs,
    code,
    err,
    extraJson,
    lossPct,
    jitterMs,
    createdAtMs: nowMs,
  });

  await tx
    .insert(probeResultLatest)
    .values({
      agentId: args.agentId,
      taskId: r.tid,
      tsMs: r.ts,
      recvTsMs: nowMs,
      ok: r.ok,
      latMs,
      code,
      err,
      extraJson,
      lossPct,
      jitterMs,
      updatedAtMs: nowMs,
    })
    .onConflictDoUpdate({
      target: [probeResultLatest.agentId, probeResultLatest.taskId],
      set: {
        tsMs: r.ts,
        recvTsMs: nowMs,
        ok: r.ok,
        latMs,
        code,
        err,
        extraJson,
        lossPct,
        jitterMs,
        updatedAtMs: nowMs,
      },
      setWhere: sql`excluded.ts_ms >= ${probeResultLatest.tsMs}`,
    });
}
