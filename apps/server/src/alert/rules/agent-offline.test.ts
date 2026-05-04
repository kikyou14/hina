import { describe, expect, test } from "bun:test";
import type { AgentAlertView } from "../../agents/registry";
import { agentOfflineRule } from "./agent-offline";
import type { DataBundle, LoadedRule } from "./types";

const NOW = 1_700_000_000_000;
const GRACE_MS = 60_000;

function makeAgent(overrides: Partial<AgentAlertView> & { id: string }): AgentAlertView {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    groupId: overrides.groupId ?? null,
    groupName: overrides.groupName ?? null,
    lastSeenAtMs: overrides.lastSeenAtMs ?? null,
    metrics: overrides.metrics ?? {},
    billing: overrides.billing ?? {
      quotaBytes: 0,
      mode: "sum",
      resetDay: 1,
      periodStartDayYyyyMmDd: 0,
      periodEndDayYyyyMmDd: 0,
      rxBytes: 0,
      txBytes: 0,
      usedBytes: 0,
      overQuota: false,
    },
    pricing: overrides.pricing ?? null,
  };
}

function makeBundle(agents: AgentAlertView[]): DataBundle {
  return {
    agents,
    probeLatestByKey: new Map(),
    probeTaskNameById: new Map(),
    metricsStaleMs: 600_000,
    missedHeartbeatGraceMs: GRACE_MS,
  };
}

function makeRule(): LoadedRule<Record<string, never>> {
  return {
    id: "rule-1",
    name: "agent offline",
    enabled: true,
    severity: "warning",
    kind: "agent_offline",
    selector: { type: "all" },
    params: {},
    forMs: 300_000,
    recoverMs: 0,
    notifyOnRecovery: true,
    updatedAtMs: NOW - 1_000_000,
  };
}

describe("agentOfflineRule.deriveTargets", () => {
  test("never-connected agent → present=false, cond=false (unactivated, not offline)", () => {
    const bundle = makeBundle([makeAgent({ id: "a1", lastSeenAtMs: null })]);
    const targets = agentOfflineRule.deriveTargets(bundle, makeRule(), NOW);

    expect(targets).toHaveLength(1);
    expect(targets[0]!.present).toBe(false);
    expect(targets[0]!.cond).toBe(false);
    expect(targets[0]!.value).toEqual({
      offline: false,
      lastSeenAtMs: null,
      offlineForMs: null,
    });
  });

  test("agent seen within grace window → present=true, cond=false", () => {
    const lastSeen = NOW - GRACE_MS / 2;
    const bundle = makeBundle([makeAgent({ id: "a1", lastSeenAtMs: lastSeen })]);
    const targets = agentOfflineRule.deriveTargets(bundle, makeRule(), NOW);

    expect(targets[0]!.present).toBe(true);
    expect(targets[0]!.cond).toBe(false);
    expect(targets[0]!.value).toEqual({
      offline: false,
      lastSeenAtMs: lastSeen,
      offlineForMs: GRACE_MS / 2,
    });
  });

  test("agent silent past grace window → present=true, cond=true", () => {
    const lastSeen = NOW - GRACE_MS - 5_000;
    const bundle = makeBundle([makeAgent({ id: "a1", lastSeenAtMs: lastSeen })]);
    const targets = agentOfflineRule.deriveTargets(bundle, makeRule(), NOW);

    expect(targets[0]!.present).toBe(true);
    expect(targets[0]!.cond).toBe(true);
    expect(targets[0]!.value.offlineForMs).toBe(GRACE_MS + 5_000);
  });

  test("agent silent exactly at grace boundary → cond=false (strict >)", () => {
    const lastSeen = NOW - GRACE_MS;
    const bundle = makeBundle([makeAgent({ id: "a1", lastSeenAtMs: lastSeen })]);
    const targets = agentOfflineRule.deriveTargets(bundle, makeRule(), NOW);

    expect(targets[0]!.cond).toBe(false);
  });

  test("selector excludes non-matching agents", () => {
    const bundle = makeBundle([
      makeAgent({ id: "a1", lastSeenAtMs: NOW, groupId: "g1" }),
      makeAgent({ id: "a2", lastSeenAtMs: NOW, groupId: "g2" }),
    ]);
    const rule: LoadedRule<Record<string, never>> = {
      ...makeRule(),
      selector: { type: "groups", groupIds: ["g1"] },
    };

    const targets = agentOfflineRule.deriveTargets(bundle, rule, NOW);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.agent.id).toBe("a1");
  });

  test("subjectKey is stable per agent for state lookup", () => {
    const bundle = makeBundle([makeAgent({ id: "a1", lastSeenAtMs: NOW - GRACE_MS - 1 })]);
    const targets = agentOfflineRule.deriveTargets(bundle, makeRule(), NOW);

    expect(targets[0]!.subjectKey).toBe("a:a1");
    expect(targets[0]!.subjectJson).toBe(JSON.stringify({ agentId: "a1" }));
  });
});
