import { describe, expect, test } from "bun:test";

import { buildAgentPricing, parsePricingRecord } from "./helpers";

describe("buildAgentPricing", () => {
  test("returns pricing when the joined row is complete", () => {
    expect(
      buildAgentPricing({
        pricingCurrency: "USD",
        pricingCycle: "monthly",
        pricingAmountUnit: 1299,
        pricingExpiresAtMs: 1_717_171_717_000,
      }),
    ).toEqual({
      currency: "USD",
      cycle: "monthly",
      amountUnit: 1299,
      expiresAtMs: 1_717_171_717_000,
    });
  });

  test("returns null when the joined row is missing required columns", () => {
    expect(
      buildAgentPricing({
        pricingCurrency: "USD",
        pricingCycle: null,
        pricingAmountUnit: 1299,
        pricingExpiresAtMs: null,
      }),
    ).toBeNull();

    expect(
      buildAgentPricing({
        pricingCurrency: "USD",
        pricingCycle: "monthly",
        pricingAmountUnit: null,
        pricingExpiresAtMs: null,
      }),
    ).toBeNull();
  });

  test("normalizes missing expiry to null", () => {
    expect(
      buildAgentPricing({
        pricingCurrency: "USD",
        pricingCycle: "monthly",
        pricingAmountUnit: 0,
        pricingExpiresAtMs: undefined,
      }),
    ).toEqual({
      currency: "USD",
      cycle: "monthly",
      amountUnit: 0,
      expiresAtMs: null,
    });
  });
});

describe("parsePricingRecord", () => {
  test("parses a valid pricing record", () => {
    expect(
      parsePricingRecord({
        currency: "USD",
        cycle: "monthly",
        amountUnit: 1299,
        expiresAtMs: 1_717_171_717_000,
      }),
    ).toEqual({
      currency: "USD",
      cycle: "monthly",
      amountUnit: 1299,
      expiresAtMs: 1_717_171_717_000,
    });
  });

  test("normalizes missing expiry to null", () => {
    expect(
      parsePricingRecord({
        currency: "USD",
        cycle: "monthly",
        amountUnit: 0,
      }),
    ).toEqual({
      currency: "USD",
      cycle: "monthly",
      amountUnit: 0,
      expiresAtMs: null,
    });

    expect(
      parsePricingRecord({
        currency: "USD",
        cycle: "monthly",
        amountUnit: 0,
        expiresAtMs: null,
      }),
    ).toEqual({
      currency: "USD",
      cycle: "monthly",
      amountUnit: 0,
      expiresAtMs: null,
    });
  });

  test("accepts triennial pricing cycle", () => {
    expect(
      parsePricingRecord({
        currency: "USD",
        cycle: "triennial",
        amountUnit: 1299,
      }),
    ).toEqual({
      currency: "USD",
      cycle: "triennial",
      amountUnit: 1299,
      expiresAtMs: null,
    });
  });

  test("rejects invalid pricing fields", () => {
    expect(
      parsePricingRecord({
        currency: "AUD",
        cycle: "monthly",
        amountUnit: 1299,
      }),
    ).toBeNull();

    expect(
      parsePricingRecord({
        currency: "USD",
        cycle: "three_year",
        amountUnit: 1299,
      }),
    ).toBeNull();

    expect(
      parsePricingRecord({
        currency: "USD",
        cycle: "monthly",
        amountUnit: -1,
      }),
    ).toBeNull();

    expect(
      parsePricingRecord({
        currency: "USD",
        cycle: "monthly",
        amountUnit: 1299,
        expiresAtMs: 0,
      }),
    ).toBeNull();
  });
});
