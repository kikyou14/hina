import { describe, expect, it } from "bun:test";
import { resolveTier } from "./probe-queries";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW_MS = 1_700_000_000_000;

describe("resolveTier", () => {
  describe("auto", () => {
    it("returns raw for short spans anchored near now", () => {
      const fromMs = NOW_MS - HOUR_MS;
      expect(resolveTier("auto", fromMs, NOW_MS, NOW_MS)).toBe("raw");
    });

    it("returns raw for an exactly-24h span anchored at now", () => {
      const fromMs = NOW_MS - DAY_MS;
      expect(resolveTier("auto", fromMs, NOW_MS, NOW_MS)).toBe("raw");
    });

    it("returns hourly for spans wider than 24h", () => {
      const fromMs = NOW_MS - DAY_MS - HOUR_MS;
      expect(resolveTier("auto", fromMs, NOW_MS, NOW_MS)).toBe("hourly");
    });

    it("avoids raw when fromMs is outside the raw retention window", () => {
      const fromMs = NOW_MS - 5 * DAY_MS;
      const toMs = fromMs + DAY_MS;
      expect(resolveTier("auto", fromMs, toMs, NOW_MS)).toBe("hourly");
    });

    it("returns hourly for week-long spans within hourly retention", () => {
      const fromMs = NOW_MS - 7 * DAY_MS;
      expect(resolveTier("auto", fromMs, NOW_MS, NOW_MS)).toBe("hourly");
    });

    it("falls back to daily once fromMs is beyond hourly retention", () => {
      const fromMs = NOW_MS - 120 * DAY_MS;
      const toMs = fromMs + DAY_MS;
      expect(resolveTier("auto", fromMs, toMs, NOW_MS)).toBe("daily");
    });
  });

  describe("explicit tier (downgrades when data is unavailable)", () => {
    it("honors raw when fromMs is fresh", () => {
      const fromMs = NOW_MS - HOUR_MS;
      expect(resolveTier("raw", fromMs, NOW_MS, NOW_MS)).toBe("raw");
    });

    it("downgrades raw to hourly when fromMs is past raw retention", () => {
      const fromMs = NOW_MS - 5 * DAY_MS;
      const toMs = fromMs + HOUR_MS;
      expect(resolveTier("raw", fromMs, toMs, NOW_MS)).toBe("hourly");
    });

    it("downgrades raw to daily when fromMs is past hourly retention", () => {
      const fromMs = NOW_MS - 200 * DAY_MS;
      const toMs = fromMs + HOUR_MS;
      expect(resolveTier("raw", fromMs, toMs, NOW_MS)).toBe("daily");
    });

    it("downgrades hourly to daily when fromMs is past hourly retention", () => {
      const fromMs = NOW_MS - 200 * DAY_MS;
      const toMs = fromMs + DAY_MS;
      expect(resolveTier("hourly", fromMs, toMs, NOW_MS)).toBe("daily");
    });

    it("always returns daily when requested", () => {
      const fromMs = NOW_MS - HOUR_MS;
      expect(resolveTier("daily", fromMs, NOW_MS, NOW_MS)).toBe("daily");
    });
  });

  describe("raw retention safety margin", () => {
    it("treats `now - 2d + 1h` as the inclusive raw boundary", () => {
      const rawFloorMs = NOW_MS - 2 * DAY_MS + HOUR_MS;
      expect(resolveTier("raw", rawFloorMs, NOW_MS, NOW_MS)).toBe("raw");
      expect(resolveTier("raw", rawFloorMs - 1, NOW_MS, NOW_MS)).toBe("hourly");
    });
  });
});
