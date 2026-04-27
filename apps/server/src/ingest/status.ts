import { eq } from "drizzle-orm";
import type { DbClient, DbTx } from "../db/client";
import { agentStatus } from "../db/schema";

export type AgentHelloStateArgs = {
  agentId: string;
  ipV4?: string | null;
  ipV6?: string | null;
  host?: string | null;
  os?: string | null;
  arch?: string | null;
  agentVersion?: string | null;
  capabilitiesJson?: string | null;
  inventoryPack?: Buffer;
  tsMs: number;
};

export async function upsertAgentHelloState(tx: DbTx, args: AgentHelloStateArgs) {
  await tx
    .insert(agentStatus)
    .values({
      agentId: args.agentId,
      online: true,
      lastSeenAtMs: args.tsMs,
      lastIpV4: args.ipV4 ?? null,
      lastIpV6: args.ipV6 ?? null,
      lastHost: args.host ?? null,
      lastOs: args.os ?? null,
      lastArch: args.arch ?? null,
      lastAgentVersion: args.agentVersion ?? null,
      lastCapabilitiesJson: args.capabilitiesJson ?? null,
      lastHelloAtMs: args.tsMs,
      lastInventoryPack: args.inventoryPack,
      updatedAtMs: args.tsMs,
    })
    .onConflictDoUpdate({
      target: agentStatus.agentId,
      set: {
        online: true,
        lastSeenAtMs: args.tsMs,
        lastIpV4: args.ipV4 ?? null,
        lastIpV6: args.ipV6 ?? null,
        lastHost: args.host ?? null,
        lastOs: args.os ?? null,
        lastArch: args.arch ?? null,
        lastAgentVersion: args.agentVersion ?? null,
        lastCapabilitiesJson: args.capabilitiesJson ?? null,
        lastHelloAtMs: args.tsMs,
        ...(args.inventoryPack ? { lastInventoryPack: args.inventoryPack } : {}),
        updatedAtMs: args.tsMs,
      },
    });
}

export async function updateAgentIps(
  tx: DbTx,
  agentId: string,
  ipV4: string | null,
  ipV6: string | null,
  tsMs: number,
) {
  await tx
    .update(agentStatus)
    .set({ lastIpV4: ipV4, lastIpV6: ipV6, updatedAtMs: tsMs })
    .where(eq(agentStatus.agentId, agentId));
}

export async function markAgentOffline(tx: DbTx, agentId: string, tsMs: number) {
  await tx
    .update(agentStatus)
    .set({ online: false, updatedAtMs: tsMs })
    .where(eq(agentStatus.agentId, agentId));
}

export async function resetAllAgentsOffline(db: DbClient) {
  await db.update(agentStatus).set({ online: false, updatedAtMs: Date.now() });
}
