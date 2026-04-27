import { isRecord } from "../../util/lang";
import { formatBytes, round, yyyyMmDdToDisplay } from "../message/vars";
import type { ValueLine, TemplateVarsBuilder } from "../message/vars";
import { matchesSelector } from "../selector";
import type { Result, ValidationError } from "../types";
import { err } from "./shared";
import type { DataBundle, EvalTarget, LoadedRule, PollRuleDefinition } from "./types";

export type QuotaExceededParams = { percentage: number };

const BILLING_MODE_DISPLAY: Record<string, string> = {
  sum: "RX + TX",
  rx: "RX only",
  tx: "TX only",
  max: "max(RX, TX)",
};

type Value = {
  usedBytes: number;
  quotaBytes: number;
  usagePct: number;
  threshold: number;
  billingMode: string;
  periodStart: number;
  periodEnd: number;
};

function subjectKey(agentId: string): string {
  return `a:${agentId}`;
}

export const quotaExceededRule: PollRuleDefinition<QuotaExceededParams, Value> = {
  kind: "quota_exceeded",
  mode: "poll",

  parseParams(raw: unknown): Result<QuotaExceededParams, ValidationError[]> {
    if (!isRecord(raw)) return err("params", "invalid_params", "params must be an object");
    const percentage = typeof raw["percentage"] === "number" ? raw["percentage"] : Number.NaN;
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100)
      return err("params.percentage", "invalid_percentage", "percentage must be 0-100");
    return { ok: true, value: { percentage } };
  },

  deriveTargets(bundle: DataBundle, rule: LoadedRule<QuotaExceededParams>): EvalTarget<Value>[] {
    const p = rule.params;
    const out: EvalTarget<Value>[] = [];
    for (const a of bundle.agents) {
      if (!matchesSelector(a, rule.selector)) continue;
      const billing = a.billing;
      const present = billing.quotaBytes > 0;
      const usagePct = present ? (billing.usedBytes / billing.quotaBytes) * 100 : 0;
      const cond = present && usagePct > p.percentage;

      out.push({
        subjectKey: subjectKey(a.id),
        subjectJson: JSON.stringify({ agentId: a.id }),
        agent: { id: a.id, name: a.name, group: a.groupName ?? null },
        present,
        cond,
        value: present
          ? {
              usedBytes: billing.usedBytes,
              quotaBytes: billing.quotaBytes,
              usagePct: round(usagePct, 1),
              threshold: p.percentage,
              billingMode: billing.mode,
              periodStart: billing.periodStartDayYyyyMmDd,
              periodEnd: billing.periodEndDayYyyyMmDd,
            }
          : {
              usedBytes: 0,
              quotaBytes: 0,
              usagePct: 0,
              threshold: p.percentage,
              billingMode: "sum",
              periodStart: 0,
              periodEnd: 0,
            },
      });
    }
    return out;
  },

  describeValue(value: Value): ValueLine[] {
    return [
      {
        label: "Usage",
        text: `${round(value.usagePct, 1)}% (${formatBytes(value.usedBytes)} / ${formatBytes(value.quotaBytes)})`,
      },
      { label: "Threshold", text: `> ${round(value.threshold, 1)}%` },
      { label: "Mode", text: BILLING_MODE_DISPLAY[value.billingMode] ?? value.billingMode },
      {
        label: "Period",
        text: `${yyyyMmDdToDisplay(value.periodStart)} ~ ${yyyyMmDdToDisplay(value.periodEnd)}`,
      },
    ];
  },

  extendTemplateVars(value: Value, b: TemplateVarsBuilder): void {
    b.set("quota.usage", `${round(value.usagePct, 1)}%`);
    b.set("quota.used", formatBytes(value.usedBytes));
    b.set("quota.total", formatBytes(value.quotaBytes));
    b.set("quota.threshold", `> ${round(value.threshold, 1)}%`);
    b.set("quota.mode", BILLING_MODE_DISPLAY[value.billingMode] ?? value.billingMode);
    b.set(
      "quota.period",
      `${yyyyMmDdToDisplay(value.periodStart)} ~ ${yyyyMmDdToDisplay(value.periodEnd)}`,
    );
  },

  sampleValue(): Value {
    return {
      usedBytes: 800_000_000_000,
      quotaBytes: 1_000_000_000_000,
      usagePct: 80,
      threshold: 75,
      billingMode: "sum",
      periodStart: 20260301,
      periodEnd: 20260401,
    };
  },
};
