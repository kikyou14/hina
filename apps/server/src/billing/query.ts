import { and, gte, inArray, lte } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { trafficDay } from "../db/schema";

const SQLITE_CHUNK_SIZE = 500;

const trafficSelect = {
  agentId: trafficDay.agentId,
  dayYyyyMmDd: trafficDay.dayYyyyMmDd,
  rxBytes: trafficDay.rxBytes,
  txBytes: trafficDay.txBytes,
} as const;

function queryChunk(db: DbClient, agentIds: string[], startDay: number, endDay: number) {
  return db
    .select(trafficSelect)
    .from(trafficDay)
    .where(
      and(
        inArray(trafficDay.agentId, agentIds),
        gte(trafficDay.dayYyyyMmDd, startDay),
        lte(trafficDay.dayYyyyMmDd, endDay),
      ),
    );
}

export async function queryTrafficRows(
  db: DbClient,
  agentIds: string[],
  startDay: number,
  endDay: number,
) {
  if (agentIds.length <= SQLITE_CHUNK_SIZE) {
    return queryChunk(db, agentIds, startDay, endDay);
  }

  const results: Awaited<ReturnType<typeof queryChunk>> = [];
  for (let i = 0; i < agentIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = agentIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const rows = await queryChunk(db, chunk, startDay, endDay);
    results.push(...rows);
  }
  return results;
}
