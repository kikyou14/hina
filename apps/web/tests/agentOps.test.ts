import { describe, expect, test } from "bun:test";

import type { PublicAgentSummary } from "../src/api/public";
import {
  applyAgentOps,
  hasUpsert,
  type AgentLivePatch,
  type PendingAgentOp,
} from "../src/live/agentOps";

function agent(id: string, name: string): PublicAgentSummary {
  return { id, name } as PublicAgentSummary;
}

function ops(entries: Array<[string, PendingAgentOp]>): Map<string, PendingAgentOp> {
  return new Map(entries);
}

function livePatch(): AgentLivePatch {
  return {
    tsMs: 200,
    latest: {
      seq: 2,
      uptimeSec: 30,
      rx: 100,
      tx: 200,
      m: { "cpu.usage_pct": 42 },
    },
    billing: {
      quotaBytes: 1_000,
      mode: "sum",
      resetDay: 1,
      periodStartDayYyyyMmDd: 20260701,
      periodEndDayYyyyMmDd: 20260722,
      rxBytes: 200,
      txBytes: 300,
      usedBytes: 500,
      overQuota: false,
    },
    traffic: {
      totalRxBytes: 1_000,
      totalTxBytes: 2_000,
      sinceDayYyyyMmDd: 20260701,
    },
  };
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

  test("patches status, telemetry, billing, and traffic without replacing metadata", () => {
    const current = {
      ...agent("a", "Alpha"),
      status: { online: false, lastSeenAtMs: 100 },
      latest: null,
      billing: null,
      traffic: null,
    } as PublicAgentSummary;
    const patch = livePatch();

    const result = applyAgentOps([current], ops([["a", { kind: "patch", patch }]]));

    expect(result[0]).toMatchObject({
      id: "a",
      name: "Alpha",
      status: { online: true, lastSeenAtMs: patch.tsMs },
      latest: patch.latest,
      billing: patch.billing,
      traffic: patch.traffic,
    });
    expect(current.status).toEqual({ online: false, lastSeenAtMs: 100 });
    expect(current.latest).toBeNull();
    expect(current.billing).toBeNull();
    expect(current.traffic).toBeNull();
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

  test("is false for a patch-only batch", () => {
    expect(hasUpsert(ops([["a", { kind: "patch", patch: livePatch() }]]))).toBe(false);
  });

  test("is false for an empty batch", () => {
    expect(hasUpsert(new Map())).toBe(false);
  });
});
