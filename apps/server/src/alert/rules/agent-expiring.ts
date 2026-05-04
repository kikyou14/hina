import { isRecord } from "../../util/lang";
import { formatTimestamp } from "../message/format";
import type { TemplateVarsBuilder, ValueLine } from "../message/format";
import { matchesSelector } from "../selector";
import type { Result, ValidationError } from "../types";
import { err } from "./shared";
import type { DataBundle, EvalTarget, LoadedRule, PollRuleDefinition } from "./types";

export type AgentExpiringParams = { daysBeforeExpiry: number };

const MS_PER_DAY = 86_400_000;

type Value = {
  expiresAtMs: number;
  daysRemaining: number;
  cycle: string;
  threshold: number;
};

function subjectKey(agentId: string): string {
  return `a:${agentId}`;
}

export const agentExpiringRule: PollRuleDefinition<AgentExpiringParams, Value> = {
  kind: "agent_expiring",
  mode: "poll",

  parseParams(raw: unknown): Result<AgentExpiringParams, ValidationError[]> {
    if (!isRecord(raw)) return err("params", "invalid_params", "params must be an object");
    const days = typeof raw["daysBeforeExpiry"] === "number" ? raw["daysBeforeExpiry"] : Number.NaN;
    if (!Number.isFinite(days) || !Number.isInteger(days) || days < 1 || days > 365)
      return err(
        "params.daysBeforeExpiry",
        "invalid_days",
        "daysBeforeExpiry must be an integer 1-365",
      );
    return { ok: true, value: { daysBeforeExpiry: days } };
  },

  deriveTargets(
    bundle: DataBundle,
    rule: LoadedRule<AgentExpiringParams>,
    nowMs: number,
  ): EvalTarget<Value>[] {
    const thresholdMs = rule.params.daysBeforeExpiry * MS_PER_DAY;
    const out: EvalTarget<Value>[] = [];
    for (const a of bundle.agents) {
      if (!matchesSelector(a, rule.selector)) continue;
      const pricing = a.pricing;
      const present = pricing !== null;
      const remainingMs = present ? pricing.expiresAtMs - nowMs : 0;
      const cond = present && remainingMs < thresholdMs;

      out.push({
        subjectKey: subjectKey(a.id),
        subjectJson: JSON.stringify({ agentId: a.id }),
        agent: { id: a.id, name: a.name, group: a.groupName ?? null },
        present,
        cond,
        value: present
          ? {
              expiresAtMs: pricing.expiresAtMs,
              daysRemaining: Math.floor(remainingMs / MS_PER_DAY),
              cycle: pricing.cycle,
              threshold: rule.params.daysBeforeExpiry,
            }
          : {
              expiresAtMs: 0,
              daysRemaining: 0,
              cycle: "unknown",
              threshold: rule.params.daysBeforeExpiry,
            },
      });
    }
    return out;
  },

  describeValue(value: Value): ValueLine[] {
    const lines: ValueLine[] = [];
    if (value.expiresAtMs > 0)
      lines.push({ label: "Expires", text: formatTimestamp(value.expiresAtMs) });
    const remaining =
      value.daysRemaining < 0
        ? `${Math.abs(value.daysRemaining)} days ago`
        : `${value.daysRemaining} days`;
    lines.push({ label: "Remaining", text: remaining });
    lines.push({ label: "Cycle", text: value.cycle });
    return lines;
  },

  extendTemplateVars(value: Value, b: TemplateVarsBuilder): void {
    b.set("expiry.date", formatTimestamp(value.expiresAtMs));
    b.set(
      "expiry.remaining",
      value.daysRemaining < 0
        ? `${Math.abs(value.daysRemaining)} days ago`
        : `${value.daysRemaining} days`,
    );
    b.set("expiry.cycle", value.cycle);
  },

  sampleValue(): Value {
    return {
      expiresAtMs: Date.now() + 5 * MS_PER_DAY,
      daysRemaining: 5,
      cycle: "monthly",
      threshold: 7,
    };
  },
};
