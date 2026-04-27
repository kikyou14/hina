export const PRICING_CYCLE_KEYS = [
  "monthly",
  "quarterly",
  "semiannual",
  "annual",
  "biennial",
  "triennial",
  "lifetime",
] as const;

export type PricingCycleKey = (typeof PRICING_CYCLE_KEYS)[number];

export const PRICING_CYCLE_SUFFIXES: Record<PricingCycleKey, string> = {
  monthly: "/mo",
  quarterly: "/q",
  semiannual: "/6mo",
  annual: "/yr",
  biennial: "/2yr",
  triennial: "/3yr",
  lifetime: "",
};

const PRICING_CYCLE_KEY_SET = new Set<string>(PRICING_CYCLE_KEYS);

export function getPricingCycleSuffix(cycle: string): string | null {
  if (!PRICING_CYCLE_KEY_SET.has(cycle)) return null;
  return PRICING_CYCLE_SUFFIXES[cycle as PricingCycleKey];
}
