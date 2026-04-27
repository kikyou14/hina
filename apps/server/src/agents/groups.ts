import { eq, sql } from "drizzle-orm";
import { parseSelector } from "../alert/selector";
import type { DbClient, DbTx } from "../db/client";
import { agent, agentGroup, alertRule, probeTaskGroup } from "../db/schema";
import { escapeLike, safeJsonParse } from "../util/lang";

type DbConn = DbClient | DbTx;

export type AgentGroupUsage = {
  agentCount: number;
  probeTaskCount: number;
  alertRuleCount: number;
};

export async function findOrCreateGroupId(
  conn: DbConn,
  groupName: string,
  nowMs: number,
): Promise<string> {
  const groupId = crypto.randomUUID();
  const [row] = await conn
    .insert(agentGroup)
    .values({ id: groupId, name: groupName, createdAtMs: nowMs, updatedAtMs: nowMs })
    .onConflictDoUpdate({ target: agentGroup.name, set: { updatedAtMs: nowMs } })
    .returning({ id: agentGroup.id });
  return row!.id;
}

export async function getAgentGroupUsage(conn: DbConn, groupId: string): Promise<AgentGroupUsage> {
  const [agentRow] = await conn
    .select({ n: sql<number>`count(*)` })
    .from(agent)
    .where(eq(agent.groupId, groupId));
  const [probeTaskRow] = await conn
    .select({ n: sql<number>`count(*)` })
    .from(probeTaskGroup)
    .where(eq(probeTaskGroup.groupId, groupId));

  const selectorRows = await conn
    .select({ selectorJson: alertRule.selectorJson })
    .from(alertRule)
    .where(sql`${alertRule.selectorJson} LIKE ${`%${escapeLike(groupId)}%`} ESCAPE '!'`);
  let alertRuleCount = 0;
  for (const row of selectorRows) {
    const selectorResult = parseSelector(safeJsonParse(row.selectorJson) ?? {});
    if (
      selectorResult.ok &&
      selectorResult.value.type === "groups" &&
      selectorResult.value.groupIds.includes(groupId)
    ) {
      alertRuleCount++;
    }
  }

  return {
    agentCount: Number(agentRow?.n ?? 0),
    probeTaskCount: Number(probeTaskRow?.n ?? 0),
    alertRuleCount,
  };
}

export async function pruneUnusedAgentGroup(
  conn: DbConn,
  groupId: string | null,
): Promise<boolean> {
  if (groupId === null) return false;

  const usage = await getAgentGroupUsage(conn, groupId);
  if (usage.agentCount > 0 || usage.probeTaskCount > 0 || usage.alertRuleCount > 0) {
    return false;
  }

  const deleted = await conn
    .delete(agentGroup)
    .where(eq(agentGroup.id, groupId))
    .returning({ id: agentGroup.id });
  return deleted.length > 0;
}

export async function pruneUnusedAgentGroups(
  conn: DbConn,
  groupIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const seen = new Set<string>();
  for (const id of groupIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    await pruneUnusedAgentGroup(conn, id);
  }
}
