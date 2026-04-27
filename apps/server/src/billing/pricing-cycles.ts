export const PRICING_CYCLES = [
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
  "biennial",
  "triennial",
  "lifetime",
] as const;

export type PricingCycle = (typeof PRICING_CYCLES)[number];
export type RenewablePricingCycle = Exclude<PricingCycle, "lifetime">;

export const RENEWABLE_PRICING_CYCLE_MONTHS: Record<RenewablePricingCycle, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
  biennial: 24,
  triennial: 36,
};

export const RENEWABLE_PRICING_CYCLES = Object.keys(
  RENEWABLE_PRICING_CYCLE_MONTHS,
) as RenewablePricingCycle[];

const PRICING_CYCLE_SET = new Set<string>(PRICING_CYCLES);
const RENEWABLE_PRICING_CYCLE_SET = new Set<string>(RENEWABLE_PRICING_CYCLES);

export function isPricingCycle(value: unknown): value is PricingCycle {
  return typeof value === "string" && PRICING_CYCLE_SET.has(value);
}

export function getPricingCycleMonths(cycle: string): number | null {
  if (!RENEWABLE_PRICING_CYCLE_SET.has(cycle)) return null;
  return RENEWABLE_PRICING_CYCLE_MONTHS[cycle as RenewablePricingCycle];
}
