import { describe, expect, test } from "bun:test";

import { computePeriodStartYyyyMmDdUtc } from "./billing";

function utc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

describe("computePeriodStartYyyyMmDdUtc", () => {
  describe("resetDay fits in every month (1-28)", () => {
    test("after reset day → period starts this month", () => {
      // Mar 20, resetDay=15 → period started Mar 15
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 3, 20), 15)).toBe(20260315);
    });

    test("on reset day → period starts today", () => {
      // Mar 15, resetDay=15 → period started Mar 15
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 3, 15), 15)).toBe(20260315);
    });

    test("before reset day → period started last month", () => {
      // Mar 10, resetDay=15 → period started Feb 15
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 3, 10), 15)).toBe(20260215);
    });

    test("year boundary: Jan 5, resetDay=15 → Dec 15 of previous year", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 1, 5), 15)).toBe(20251215);
    });

    test("resetDay=1, mid-month → period started 1st of this month", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 7, 18), 1)).toBe(20260701);
    });
  });

  describe("resetDay=29 (overflows in non-leap February)", () => {
    test("non-leap year: Feb 15, resetDay=29 → Jan 29", () => {
      // 2026 is not a leap year (Feb has 28 days)
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 2, 15), 29)).toBe(20260129);
    });

    test("non-leap year: Mar 1, resetDay=29 → Mar 1 (Feb overflow)", () => {
      // Feb 29 doesn't exist in 2026, so effective reset is Mar 1
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 3, 1), 29)).toBe(20260301);
    });

    test("non-leap year: Mar 15, resetDay=29 → Mar 1 (Feb overflow)", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 3, 15), 29)).toBe(20260301);
    });

    test("non-leap year: Mar 29, resetDay=29 → Mar 29", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 3, 29), 29)).toBe(20260329);
    });

    test("leap year: Feb 15, resetDay=29 → Jan 29", () => {
      // 2028 is a leap year (Feb has 29 days)
      expect(computePeriodStartYyyyMmDdUtc(utc(2028, 2, 15), 29)).toBe(20280129);
    });

    test("leap year: Mar 1, resetDay=29 → Feb 29", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2028, 3, 1), 29)).toBe(20280229);
    });
  });

  describe("resetDay=30 (overflows in February)", () => {
    test("Feb 20, resetDay=30 → Jan 30", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 2, 20), 30)).toBe(20260130);
    });

    test("Mar 1, resetDay=30 → Mar 1 (Feb overflow)", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 3, 1), 30)).toBe(20260301);
    });

    test("Apr 15, resetDay=30 → Mar 30", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 4, 15), 30)).toBe(20260330);
    });
  });

  describe("resetDay=31 (overflows in months with <31 days)", () => {
    test("Jan 31, resetDay=31 → Jan 31", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 1, 31), 31)).toBe(20260131);
    });

    test("Feb 15, resetDay=31 → Jan 31", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 2, 15), 31)).toBe(20260131);
    });

    test("Mar 1, resetDay=31 → Mar 1 (Feb overflow)", () => {
      // Feb has 28 days, Feb 31 → Mar 1
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 3, 1), 31)).toBe(20260301);
    });

    test("Mar 15, resetDay=31 → Mar 1 (Feb overflow)", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 3, 15), 31)).toBe(20260301);
    });

    test("Mar 31, resetDay=31 → Mar 31", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 3, 31), 31)).toBe(20260331);
    });

    test("Apr 15, resetDay=31 → Mar 31", () => {
      // Apr has 30 days, so before Apr 31 (= May 1) → Mar 31
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 4, 15), 31)).toBe(20260331);
    });

    test("May 1, resetDay=31 → May 1 (Apr overflow)", () => {
      // Apr has 30 days, Apr 31 → May 1
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 5, 1), 31)).toBe(20260501);
    });

    test("May 15, resetDay=31 → May 1 (Apr overflow)", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 5, 15), 31)).toBe(20260501);
    });

    test("Jul 31, resetDay=31 → Jul 31", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 7, 31), 31)).toBe(20260731);
    });

    test("year boundary: Jan 5, resetDay=31 → Dec 31 of previous year", () => {
      expect(computePeriodStartYyyyMmDdUtc(utc(2026, 1, 5), 31)).toBe(20251231);
    });
  });
});
