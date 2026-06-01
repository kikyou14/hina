import { describe, expect, test } from "bun:test";

import type { PublicAgentSummary } from "../src/api/public";
import { applyAgentOps, hasUpsert, type PendingAgentOp } from "../src/live/agentOps";

function agent(id: string, name: string): PublicAgentSummary {
  return { id, name } as PublicAgentSummary;
}

function ops(entries: Array<[string, PendingAgentOp]>): Map<string, PendingAgentOp> {
  return new Map(entries);
}

describe("applyAgentOps", () => {
  test("returns a fresh copy when there are no ops", () => {
    const list = [agent("a", "Alpha")];
    const result = applyAgentOps(list, new Map());
    expect(result).toEqual(list);
    expect(result).not.toBe(list);
  });

  test("replaces an existing agent in place without reordering", () => {
    const list = [agent("b", "Bravo"), agent("a", "Alpha")];
    const result = applyAgentOps(
      list,
      ops([["b", { kind: "upsert", agent: agent("b", "Bravo v2") }]]),
    );
    // Order preserved (no re-sort) so rows do not jump on every telemetry tick.
    expect(result.map((a) => a.id)).toEqual(["b", "a"]);
    expect(result[0].name).toBe("Bravo v2");
  });

  test("appends a newly seen agent in arrival order without sorting", () => {
    const list = [agent("b", "Bravo"), agent("d", "Delta")];
    const result = applyAgentOps(
      list,
      ops([["a", { kind: "upsert", agent: agent("a", "Alpha") }]]),
    );
    // No client-side sort: the new agent lands at the end until a snapshot or
    // refetch restores the authoritative (displayOrder, name) order.
    expect(result.map((a) => a.name)).toEqual(["Bravo", "Delta", "Alpha"]);
  });

  test("removes an existing agent", () => {
    const list = [agent("a", "Alpha"), agent("b", "Bravo")];
    const result = applyAgentOps(list, ops([["a", { kind: "remove" }]]));
    expect(result.map((a) => a.id)).toEqual(["b"]);
  });

  test("ignores removal of an unknown agent", () => {
    const list = [agent("a", "Alpha")];
    const result = applyAgentOps(list, ops([["zzz", { kind: "remove" }]]));
    expect(result.map((a) => a.id)).toEqual(["a"]);
  });

  test("applies in-place updates, removals, and appends together", () => {
    // Deliberately non-alphabetical to prove the result is not re-sorted.
    const list = [agent("c", "Charlie"), agent("a", "Alpha"), agent("b", "Bravo")];
    const result = applyAgentOps(
      list,
      ops([
        ["b", { kind: "remove" }],
        ["c", { kind: "upsert", agent: agent("c", "Charlie v2") }],
        ["d", { kind: "upsert", agent: agent("d", "Delta") }],
      ]),
    );
    // b dropped; c replaced in place; d appended at the end; order preserved.
    expect(result.map((a) => a.name)).toEqual(["Charlie v2", "Alpha", "Delta"]);
    expect(result.find((a) => a.id === "c")?.name).toBe("Charlie v2");
  });

  test("does not mutate the input list", () => {
    const list = [agent("a", "Alpha")];
    applyAgentOps(list, ops([["b", { kind: "upsert", agent: agent("b", "Bravo") }]]));
    expect(list.map((a) => a.id)).toEqual(["a"]);
  });
});

describe("hasUpsert", () => {
  test("is true when any op is an upsert", () => {
    const result = hasUpsert(
      ops([
        ["a", { kind: "remove" }],
        ["b", { kind: "upsert", agent: agent("b", "Bravo") }],
      ]),
    );
    expect(result).toBe(true);
  });

  test("is false for a remove-only batch", () => {
    expect(hasUpsert(ops([["a", { kind: "remove" }]]))).toBe(false);
  });

  test("is false for an empty batch", () => {
    expect(hasUpsert(new Map())).toBe(false);
  });
});
