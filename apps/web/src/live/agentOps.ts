import type { PublicAgentSummary } from "@/api/public";

export type PendingAgentOp =
  | { readonly kind: "upsert"; readonly agent: PublicAgentSummary }
  | { readonly kind: "remove" };

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
