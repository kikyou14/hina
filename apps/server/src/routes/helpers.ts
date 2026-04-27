import { isPricingCycle } from "../billing/pricing-cycles";
import { decodeEnvelope, MessageType, parseTelemetryBody } from "../protocol/envelope";
import type { Resolution } from "../series/resolution";

export function parseJsonArray(value: string): unknown[] {
  try {
    const decoded = JSON.parse(value);
    return Array.isArray(decoded) ? decoded : [];
  } catch {
    return [];
  }
}

export function parseTagsJson(value: string): string[] {
  const arr = parseJsonArray(value);
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string" && item) out.push(item);
  }
  return out;
}

export function parseMs(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export function parseResolution(value: string | undefined): Resolution {
  return value === "raw" ? "raw" : "auto";
}

export function parseMaxPoints(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 100), 20000);
}

export function parseMaxProbePoints(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 100), 50_000);
}

export type ProbeSeriesTier = "raw" | "hourly" | "daily" | "auto";

export function parseProbeSeriesTier(value: string | undefined): ProbeSeriesTier {
  if (value === "raw" || value === "hourly" || value === "daily") return value;
  return "auto";
}

export function decodeLatestTelemetry(pack: Buffer | null) {
  if (!pack) return null;
  const envelope = decodeEnvelope(pack);
  if (!envelope || envelope.t !== MessageType.Telemetry) return null;
  const body = parseTelemetryBody(envelope.b);
  if (!body) return null;
  return {
    seq: body.seq,
    uptimeSec: body.up_s ?? null,
    rx: body.rx,
    tx: body.tx,
    m: body.m,
  };
}

export type AgentPricingWire = {
  currency: string;
  cycle: string;
  amountUnit: number;
  expiresAtMs: number | null;
};

const VALID_CURRENCIES = new Set(["CNY", "USD", "EUR", "GBP", "CHF"]);
function parseCurrency(value: unknown): string | null {
  return typeof value === "string" && VALID_CURRENCIES.has(value) ? value : null;
}

function parseCycle(value: unknown): string | null {
  return isPricingCycle(value) ? value : null;
}

function parseAmountUnit(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0)
    return null;
  return value;
}

function parseExpiresAtMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function parsePricingRecord(input: Record<string, unknown>): AgentPricingWire | null {
  const currency = parseCurrency(input["currency"]);
  const cycle = parseCycle(input["cycle"]);
  const amountUnit = parseAmountUnit(input["amountUnit"]);
  if (!currency || !cycle || amountUnit === null) return null;

  const rawExpiresAtMs = input["expiresAtMs"];
  const expiresAtMs =
    rawExpiresAtMs === null || rawExpiresAtMs === undefined
      ? null
      : parseExpiresAtMs(rawExpiresAtMs);
  if (rawExpiresAtMs !== null && rawExpiresAtMs !== undefined && expiresAtMs === null) return null;

  return { currency, cycle, amountUnit, expiresAtMs };
}

type AgentPricingRow = {
  pricingCurrency: string | null;
  pricingCycle: string | null;
  pricingAmountUnit: number | null;
  pricingExpiresAtMs: number | null | undefined;
};

export function buildAgentPricing(row: AgentPricingRow): AgentPricingWire | null {
  // LEFT JOIN makes these columns nullable in query results even though the table schema is stricter.
  if (row.pricingCurrency === null || row.pricingCycle === null || row.pricingAmountUnit === null)
    return null;
  return {
    currency: row.pricingCurrency,
    cycle: row.pricingCycle,
    amountUnit: row.pricingAmountUnit,
    expiresAtMs: row.pricingExpiresAtMs ?? null,
  };
}
