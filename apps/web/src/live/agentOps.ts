import type { PublicAgentSummary, PublicTelemetry } from "@/api/public";

export type AgentLivePatch = {
  readonly tsMs: number;
  readonly latest: PublicTelemetry;
  readonly billing: PublicAgentSummary["billing"];
  readonly traffic: PublicAgentSummary["traffic"];
};

export type PendingAgentOp =
  | { readonly kind: "upsert"; readonly agent: PublicAgentSummary }
  | { readonly kind: "patch"; readonly patch: AgentLivePatch }
  | { readonly kind: "remove" };

type LivePatchable = {
  status: PublicAgentSummary["status"];
  latest: PublicAgentSummary["latest"];
  billing: PublicAgentSummary["billing"];
  traffic: PublicAgentSummary["traffic"];
};

export function applyLivePatch<T extends LivePatchable>(agent: T, patch: AgentLivePatch): T {
  return {
    ...agent,
    status: { ...agent.status, online: true, lastSeenAtMs: patch.tsMs },
    latest: patch.latest,
    billing: patch.billing,
    traffic: patch.traffic,
  };
}

export function applyAgentOps(
  list: readonly PublicAgentSummary[],
  ops: ReadonlyMap<string, PendingAgentOp>,
): PublicAgentSummary[] {
  if (ops.size === 0) return [...list];

  const next = [...list];
  const indexById = new Map(list.map((agent, index) => [agent.id, index] as const));
  const removedIds = new Set<string>();

  for (const [id, op] of ops) {
    if (op.kind === "remove") {
      if (indexById.has(id)) removedIds.add(id);
      continue;
    }
    const index = indexById.get(id);
    if (op.kind === "patch") {
      if (index !== undefined) next[index] = applyLivePatch(next[index]!, op.patch);
      continue;
    }
    if (index === undefined) {
      next.push(op.agent);
    } else {
      next[index] = op.agent;
    }
  }

  return removedIds.size > 0 ? next.filter((agent) => !removedIds.has(agent.id)) : next;
}

export function hasUpsert(ops: ReadonlyMap<string, PendingAgentOp>): boolean {
  for (const op of ops.values()) {
    if (op.kind === "upsert") return true;
  }
  return false;
}
