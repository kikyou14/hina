import { describe, expect, test } from "bun:test";

import type { AdminAgent } from "../src/api/adminAgents";
import { patchAdminAgent } from "../src/live/admin";

function makeAgent(overrides?: Partial<AdminAgent>): AdminAgent {
  return {
    id: "agent_1",
    name: "Agent 1",
    isPublic: false,
    tags: [],
    note: null,
    group: null,
    groupId: null,
    geo: {
      countryCode: null,
      country: null,
      source: null,
    },
    status: {
      online: true,
      lastSeenAtMs: 1,
      lastIpV4: "203.0.113.10",
      lastIpV6: "2001:db8::10",
    },
    system: {
      os: null,
      arch: null,
      agentVersion: null,
      helloAtMs: null,
      host: null,
      capabilities: null,
    },
    inventory: null,
    latest: null,
    billing: {
      quotaBytes: 0,
      mode: "sum",
      resetDay: 1,
      periodStartDayYyyyMmDd: 20260101,
      periodEndDayYyyyMmDd: 20260101,
      rxBytes: 0,
      txBytes: 0,
      usedBytes: 0,
      overQuota: false,
    },
    ...overrides,
  };
}

describe("patchAdminAgent", () => {
  test("returns the original agent when agentId mismatches", () => {
    const agent = makeAgent();
    const out = patchAdminAgent(agent, {
      type: "event.admin.agent_delta",
      agentId: "other",
      status: { online: false, lastSeenAtMs: 2 },
    });
    expect(out).toBe(agent);
  });

  test("preserves IPs when delta omits them (undefined)", () => {
    const agent = makeAgent({
      status: {
        online: true,
        lastSeenAtMs: 100,
        lastIpV4: "198.51.100.7",
        lastIpV6: "2001:db8::7",
      },
    });

    const out = patchAdminAgent(agent, {
      type: "event.admin.agent_delta",
      agentId: agent.id,
      status: { online: false, lastSeenAtMs: 101 },
    });

    expect(out.status.online).toBe(false);
    expect(out.status.lastSeenAtMs).toBe(101);
    expect(out.status.lastIpV4).toBe("198.51.100.7");
    expect(out.status.lastIpV6).toBe("2001:db8::7");
  });

  test("clears IP family when delta sets it to null", () => {
    const agent = makeAgent({
      status: {
        online: true,
        lastSeenAtMs: 100,
        lastIpV4: "198.51.100.7",
        lastIpV6: "2001:db8::7",
      },
    });

    const out = patchAdminAgent(agent, {
      type: "event.admin.agent_delta",
      agentId: agent.id,
      status: { online: true, lastSeenAtMs: 101, lastIpV4: null },
    });

    expect(out.status.lastIpV4).toBe(null);
    expect(out.status.lastIpV6).toBe("2001:db8::7");
  });

  test("overwrites IP family when delta sets it to a string", () => {
    const agent = makeAgent({
      status: {
        online: true,
        lastSeenAtMs: 100,
        lastIpV4: "198.51.100.7",
        lastIpV6: "2001:db8::7",
      },
    });

    const out = patchAdminAgent(agent, {
      type: "event.admin.agent_delta",
      agentId: agent.id,
      status: {
        online: true,
        lastSeenAtMs: 101,
        lastIpV4: "203.0.113.10",
        lastIpV6: null,
      },
    });

    expect(out.status.lastIpV4).toBe("203.0.113.10");
    expect(out.status.lastIpV6).toBe(null);
  });

  test("merges system.agentVersion when delta carries it", () => {
    const agent = makeAgent({
      system: {
        os: "linux",
        arch: "x86_64",
        agentVersion: "0.2.6",
        helloAtMs: 50,
        host: "host-1",
        capabilities: null,
      },
    });

    const out = patchAdminAgent(agent, {
      type: "event.admin.agent_delta",
      agentId: agent.id,
      status: { online: true, lastSeenAtMs: 101 },
      system: { agentVersion: "0.2.7" },
    });

    expect(out.system.agentVersion).toBe("0.2.7");
    expect(out.system.os).toBe("linux");
    expect(out.system.host).toBe("host-1");
  });

  test("preserves system when delta omits it", () => {
    const agent = makeAgent({
      system: {
        os: null,
        arch: null,
        agentVersion: "0.2.6",
        helloAtMs: null,
        host: null,
        capabilities: null,
      },
    });

    const out = patchAdminAgent(agent, {
      type: "event.admin.agent_delta",
      agentId: agent.id,
      status: { online: false, lastSeenAtMs: 200 },
    });

    expect(out.system).toBe(agent.system);
    expect(out.system.agentVersion).toBe("0.2.6");
  });
});
