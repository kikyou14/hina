import { and, gte, inArray, lte, sql } from "drizzle-orm";
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

export type TrafficTotalsRow = {
  agentId: string;
  totalRxBytes: number;
  totalTxBytes: number;
  sinceDayYyyyMmDd: number;
};

function queryTotalsChunk(db: DbClient, agentIds: string[]): Promise<TrafficTotalsRow[]> {
  return db
    .select({
      agentId: trafficDay.agentId,
      totalRxBytes: sql<number>`sum(${trafficDay.rxBytes})`,
      totalTxBytes: sql<number>`sum(${trafficDay.txBytes})`,
      sinceDayYyyyMmDd: sql<number>`min(${trafficDay.dayYyyyMmDd})`,
    })
    .from(trafficDay)
    .where(inArray(trafficDay.agentId, agentIds))
    .groupBy(trafficDay.agentId);
}

export async function queryTrafficTotals(
  db: DbClient,
  agentIds: string[],
): Promise<TrafficTotalsRow[]> {
  if (agentIds.length <= SQLITE_CHUNK_SIZE) {
    return queryTotalsChunk(db, agentIds);
  }

  const results: TrafficTotalsRow[] = [];
  for (let i = 0; i < agentIds.length; i += SQLITE_CHUNK_SIZE) {
    const chunk = agentIds.slice(i, i + SQLITE_CHUNK_SIZE);
    const rows = await queryTotalsChunk(db, chunk);
    results.push(...rows);
  }
  return results;
}
