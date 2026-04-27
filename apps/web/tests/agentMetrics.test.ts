import { describe, expect, test } from "bun:test";

import type { PublicAgentSummary } from "../src/api/public";
import {
  computeAgentExpiryKey,
  computeAgentUptime,
  computeAgentUptimeDays,
  computeDaysUntilReset,
} from "../src/lib/agentMetrics";

function utc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

function makeAgent(overrides: Partial<PublicAgentSummary> = {}): PublicAgentSummary {
  const base: PublicAgentSummary = {
    id: "agent-1",
    name: "Agent 1",
    group: null,
    tags: [],
    geo: {
      countryCode: null,
      country: null,
    },
    status: {
      online: true,
      lastSeenAtMs: utc(2026, 3, 15),
    },
    system: {
      os: null,
      arch: null,
      agentVersion: null,
      helloAtMs: null,
    },
    latest: {
      seq: 1,
      uptimeSec: 0,
      rx: 0,
      tx: 0,
      m: {},
    },
    billing: null,
    pricing: null,
  };

  return {
    ...base,
    ...overrides,
    geo: { ...base.geo, ...(overrides.geo ?? {}) },
    status: { ...base.status, ...(overrides.status ?? {}) },
    system: { ...base.system, ...(overrides.system ?? {}) },
  };
}

describe("agent time selectors", () => {
  test("computeAgentUptime returns the displayed uptime text", () => {
    const nowMs = utc(2026, 3, 15) + 10_000;
    const agent = makeAgent({
      latest: {
        seq: 1,
        uptimeSec: 59,
        rx: 0,
        tx: 0,
        m: {},
      },
    });

    expect(computeAgentUptime(agent, nowMs)).toBe("1m 9s");
  });

  test("computeAgentUptimeDays returns a stable day bucket", () => {
    const nowMs = utc(2026, 3, 15) + 10_000;
    const agent = makeAgent({
      latest: {
        seq: 1,
        uptimeSec: 86_390,
        rx: 0,
        tx: 0,
        m: {},
      },
    });

    expect(computeAgentUptimeDays(agent, nowMs)).toBe(1);
  });

  test("computeAgentUptimeDays returns 0 for unavailable uptime", () => {
    const agent = makeAgent({ latest: null });
    expect(computeAgentUptimeDays(agent, utc(2026, 3, 15))).toBe(0);
  });

  test("computeAgentExpiryKey returns primitive render buckets", () => {
    const nowMs = utc(2026, 3, 15);

    expect(computeAgentExpiryKey(makeAgent(), nowMs)).toBe("none");
    expect(
      computeAgentExpiryKey(
        makeAgent({
          pricing: {
            amountUnit: 100,
            currency: "USD",
            cycle: "monthly",
            expiresAtMs: nowMs + 2 * 86_400_000 + 1_000,
          },
        }),
        nowMs,
      ),
    ).toBe("active:2");
    expect(
      computeAgentExpiryKey(
        makeAgent({
          pricing: {
            amountUnit: 100,
            currency: "USD",
            cycle: "monthly",
            expiresAtMs: nowMs + 1_000,
          },
        }),
        nowMs,
      ),
    ).toBe("active:0");
    expect(
      computeAgentExpiryKey(
        makeAgent({
          pricing: {
            amountUnit: 100,
            currency: "USD",
            cycle: "monthly",
            expiresAtMs: nowMs - 1,
          },
        }),
        nowMs,
      ),
    ).toBe("expired");
    expect(
      computeAgentExpiryKey(
        makeAgent({
          pricing: {
            amountUnit: 100,
            currency: "USD",
            cycle: "monthly",
            expiresAtMs: nowMs,
          },
        }),
        nowMs,
      ),
    ).toBe("expired");
  });
});

describe("computeDaysUntilReset", () => {
  describe("invalid resetDay → null", () => {
    test.each([0, -1, 32, 1.5, NaN, Infinity])("resetDay=%s", (day: number) => {
      expect(computeDaysUntilReset(day, utc(2026, 3, 15))).toBeNull();
    });
  });

  describe("resetDay fits in every month (1–28)", () => {
    test("before reset day → days until this month's reset", () => {
      // Mar 10, resetDay=15 → 5 days
      expect(computeDaysUntilReset(15, utc(2026, 3, 10))).toBe(5);
    });

    test("on reset day → next reset is next month", () => {
      // Mar 15, resetDay=15 → next reset Apr 15 = 31 days
      expect(computeDaysUntilReset(15, utc(2026, 3, 15))).toBe(31);
    });

    test("after reset day → next reset is next month", () => {
      // Mar 20, resetDay=15 → next reset Apr 15 = 26 days
      expect(computeDaysUntilReset(15, utc(2026, 3, 20))).toBe(26);
    });

    test("resetDay=1, mid-month → next reset is 1st of next month", () => {
      // Jul 18, resetDay=1 → next reset Aug 1 = 14 days
      expect(computeDaysUntilReset(1, utc(2026, 7, 18))).toBe(14);
    });

    test("resetDay=1, on 1st → next reset is 1st of next month", () => {
      // Jul 1, resetDay=1 → next reset Aug 1 = 31 days
      expect(computeDaysUntilReset(1, utc(2026, 7, 1))).toBe(31);
    });

    test("year boundary: Dec 20, resetDay=15 → next reset Jan 15 = 26 days", () => {
      expect(computeDaysUntilReset(15, utc(2026, 12, 20))).toBe(26);
    });

    test("year boundary: Jan 5, resetDay=15 → 10 days", () => {
      expect(computeDaysUntilReset(15, utc(2026, 1, 5))).toBe(10);
    });
  });

  describe("resetDay=29 (overflows in non-leap February)", () => {
    test("non-leap year: Feb 15 → next reset Mar 1 (Feb overflow) = 14 days", () => {
      expect(computeDaysUntilReset(29, utc(2026, 2, 15))).toBe(14);
    });

    test("non-leap year: Mar 1 (effective Feb reset) → next reset Mar 29 = 28 days", () => {
      expect(computeDaysUntilReset(29, utc(2026, 3, 1))).toBe(28);
    });

    test("non-leap year: Mar 15 → next reset Mar 29 = 14 days", () => {
      expect(computeDaysUntilReset(29, utc(2026, 3, 15))).toBe(14);
    });

    test("non-leap year: Mar 29 (on reset day) → next reset Apr 29 = 31 days", () => {
      expect(computeDaysUntilReset(29, utc(2026, 3, 29))).toBe(31);
    });

    test("leap year: Feb 15 → next reset Feb 29 = 14 days", () => {
      expect(computeDaysUntilReset(29, utc(2028, 2, 15))).toBe(14);
    });

    test("leap year: Feb 29 (on reset day) → next reset Mar 29 = 29 days", () => {
      expect(computeDaysUntilReset(29, utc(2028, 2, 29))).toBe(29);
    });

    test("leap year: Mar 1 → next reset Mar 29 = 28 days", () => {
      expect(computeDaysUntilReset(29, utc(2028, 3, 1))).toBe(28);
    });
  });

  describe("resetDay=30 (overflows in February)", () => {
    test("Feb 20 → next reset Mar 1 (Feb overflow) = 9 days", () => {
      expect(computeDaysUntilReset(30, utc(2026, 2, 20))).toBe(9);
    });

    test("Mar 1 (effective Feb reset) → next reset Mar 30 = 29 days", () => {
      expect(computeDaysUntilReset(30, utc(2026, 3, 1))).toBe(29);
    });

    test("Apr 15 → next reset Apr 30 = 15 days", () => {
      expect(computeDaysUntilReset(30, utc(2026, 4, 15))).toBe(15);
    });
  });

  describe("resetDay=31 (overflows in months with <31 days)", () => {
    test("Jan 31 (on reset day) → next reset Mar 1 (Feb overflow) = 29 days", () => {
      expect(computeDaysUntilReset(31, utc(2026, 1, 31))).toBe(29);
    });

    test("Feb 15 → next reset Mar 1 (Feb overflow) = 14 days", () => {
      expect(computeDaysUntilReset(31, utc(2026, 2, 15))).toBe(14);
    });

    test("Mar 1 (effective Feb reset) → next reset Mar 31 = 30 days", () => {
      expect(computeDaysUntilReset(31, utc(2026, 3, 1))).toBe(30);
    });

    test("Mar 15 → next reset Mar 31 = 16 days", () => {
      expect(computeDaysUntilReset(31, utc(2026, 3, 15))).toBe(16);
    });

    test("Mar 31 (on reset day) → next reset May 1 (Apr overflow) = 31 days", () => {
      expect(computeDaysUntilReset(31, utc(2026, 3, 31))).toBe(31);
    });

    test("Apr 15 → next reset May 1 (Apr overflow) = 16 days", () => {
      expect(computeDaysUntilReset(31, utc(2026, 4, 15))).toBe(16);
    });

    test("May 1 (effective Apr reset) → next reset May 31 = 30 days", () => {
      expect(computeDaysUntilReset(31, utc(2026, 5, 1))).toBe(30);
    });

    test("Jul 31 (on reset day) → next reset Aug 31 = 31 days", () => {
      expect(computeDaysUntilReset(31, utc(2026, 7, 31))).toBe(31);
    });

    test("year boundary: Jan 5, resetDay=31 → next reset Jan 31 = 26 days", () => {
      expect(computeDaysUntilReset(31, utc(2026, 1, 5))).toBe(26);
    });

    test("year boundary: Dec 31, resetDay=31 → next reset Jan 31 = 31 days", () => {
      expect(computeDaysUntilReset(31, utc(2026, 12, 31))).toBe(31);
    });
  });
});
