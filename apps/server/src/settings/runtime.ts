import { eq, or } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { appKv } from "../db/schema";

export type RuntimeAgentConfig = {
  telemetryIntervalMs: number;
  telemetryJitterMs: number;
};

export type RuntimeConfigSource = {
  telemetryIntervalMs: "default" | "db";
  telemetryJitterMs: "default" | "db";
};

export const RUNTIME_AGENT_DEFAULTS: RuntimeAgentConfig = {
  telemetryIntervalMs: 2000,
  telemetryJitterMs: 1000,
};

const KV_KEYS = {
  telemetryIntervalMs: "runtime.agent.telemetryIntervalMs",
  telemetryJitterMs: "runtime.agent.telemetryJitterMs",
} as const;

function parseBoundedInt(value: string, args: { min: number; max: number }): number | null {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < args.min || n > args.max) return null;
  return n;
}

export function parseTelemetryIntervalMs(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1000 &&
    value <= 3_600_000
    ? value
    : null;
}

export function parseTelemetryJitterMs(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 600_000
    ? value
    : null;
}

export function validateRuntimeAgentConfig(config: RuntimeAgentConfig): RuntimeAgentConfig {
  const telemetryIntervalMs = parseTelemetryIntervalMs(config.telemetryIntervalMs);
  const telemetryJitterMs = parseTelemetryJitterMs(config.telemetryJitterMs);

  if (telemetryIntervalMs === null) throw new Error("Invalid telemetryIntervalMs");
  if (telemetryJitterMs === null) throw new Error("Invalid telemetryJitterMs");

  return {
    telemetryIntervalMs,
    telemetryJitterMs,
  };
}

export async function loadRuntimeAgentConfig(db: DbClient): Promise<{
  current: RuntimeAgentConfig;
  source: RuntimeConfigSource;
}> {
  const rows = await db
    .select({
      key: appKv.key,
      value: appKv.value,
    })
    .from(appKv)
    .where(
      or(eq(appKv.key, KV_KEYS.telemetryIntervalMs), eq(appKv.key, KV_KEYS.telemetryJitterMs))!,
    );

  let telemetryIntervalMs = RUNTIME_AGENT_DEFAULTS.telemetryIntervalMs;
  let telemetryJitterMs = RUNTIME_AGENT_DEFAULTS.telemetryJitterMs;

  const source: RuntimeConfigSource = {
    telemetryIntervalMs: "default",
    telemetryJitterMs: "default",
  };

  for (const row of rows) {
    if (row.key === KV_KEYS.telemetryIntervalMs) {
      const parsed = parseBoundedInt(row.value, { min: 1000, max: 3_600_000 });
      if (parsed !== null) {
        telemetryIntervalMs = parsed;
        source.telemetryIntervalMs = "db";
      }
      continue;
    }
    if (row.key === KV_KEYS.telemetryJitterMs) {
      const parsed = parseBoundedInt(row.value, { min: 0, max: 600_000 });
      if (parsed !== null) {
        telemetryJitterMs = parsed;
        source.telemetryJitterMs = "db";
      }
    }
  }

  return {
    current: validateRuntimeAgentConfig({
      telemetryIntervalMs,
      telemetryJitterMs,
    }),
    source,
  };
}

export async function saveRuntimeAgentConfig(
  db: DbClient,
  patch: Partial<RuntimeAgentConfig>,
): Promise<void> {
  const nowMs = Date.now();
  const rows: Array<{ key: string; value: string; updatedAtMs: number }> = [];

  if (patch.telemetryIntervalMs !== undefined) {
    rows.push({
      key: KV_KEYS.telemetryIntervalMs,
      value: String(patch.telemetryIntervalMs),
      updatedAtMs: nowMs,
    });
  }
  if (patch.telemetryJitterMs !== undefined) {
    rows.push({
      key: KV_KEYS.telemetryJitterMs,
      value: String(patch.telemetryJitterMs),
      updatedAtMs: nowMs,
    });
  }

  for (const row of rows) {
    await db
      .insert(appKv)
      .values(row)
      .onConflictDoUpdate({
        target: appKv.key,
        set: {
          value: row.value,
          updatedAtMs: row.updatedAtMs,
        },
      });
  }
}

export class RuntimeAgentConfigStore {
  private current: RuntimeAgentConfig;
  private source: RuntimeConfigSource;

  constructor(args: { current: RuntimeAgentConfig; source: RuntimeConfigSource }) {
    this.current = { ...args.current };
    this.source = { ...args.source };
  }

  getDefaults(): RuntimeAgentConfig {
    return { ...RUNTIME_AGENT_DEFAULTS };
  }

  getCurrent(): RuntimeAgentConfig {
    return { ...this.current };
  }

  getSource(): RuntimeConfigSource {
    return { ...this.source };
  }

  setCurrent(args: { current: RuntimeAgentConfig; source: RuntimeConfigSource }) {
    this.current = { ...args.current };
    this.source = { ...args.source };
  }
}
