import { isRecord } from "../../util/lang";
import { formatMetricValue, metricDisplayName } from "../message/format";
import type { TemplateVarsBuilder, ValueLine } from "../message/format";
import { matchesSelector } from "../selector";
import type { Result, ValidationError } from "../types";
import { err } from "./shared";
import type { DataBundle, EvalTarget, LoadedRule, PollRuleDefinition } from "./types";

export type MetricThresholdParams = {
  metric: string;
  op: ">" | "<";
  value: number;
  missing?: "ignore" | "alert";
};

type Value = {
  metric: string;
  op: string;
  threshold: number;
  value: number | null;
  missing: boolean;
};

function subjectKey(agentId: string): string {
  return `a:${agentId}`;
}

function parseOp(v: unknown): ">" | "<" | null {
  if (v === ">" || v === "<") return v;
  return null;
}

export const metricThresholdRule: PollRuleDefinition<MetricThresholdParams, Value> = {
  kind: "metric_threshold",
  mode: "poll",

  parseParams(raw: unknown): Result<MetricThresholdParams, ValidationError[]> {
    if (!isRecord(raw)) return err("params", "invalid_params", "params must be an object");

    const metric = typeof raw["metric"] === "string" ? raw["metric"].trim() : "";
    if (!metric) return err("params.metric", "missing_metric", "metric is required");

    const op = parseOp(raw["op"]);
    if (!op) return err("params.op", "invalid_op", 'op must be ">" or "<"');

    const value = typeof raw["value"] === "number" ? raw["value"] : Number.NaN;
    if (!Number.isFinite(value))
      return err("params.value", "invalid_value", "value must be a finite number");

    const missing = raw["missing"] === "alert" ? ("alert" as const) : ("ignore" as const);
    return { ok: true, value: { metric, op, value, missing } };
  },

  deriveTargets(
    bundle: DataBundle,
    rule: LoadedRule<MetricThresholdParams>,
    nowMs: number,
  ): EvalTarget<Value>[] {
    const p = rule.params;
    return bundle.agents
      .filter((a) => matchesSelector(a, rule.selector))
      .map((a) => {
        const lastSeenAtMs = a.lastSeenAtMs ?? 0;
        const isStale = lastSeenAtMs <= 0 || nowMs - lastSeenAtMs > bundle.metricsStaleMs;
        const val = isStale ? undefined : a.metrics[p.metric];
        const hasValue = typeof val === "number" && Number.isFinite(val);

        const present = !isStale;
        const cond = present
          ? hasValue
            ? p.op === ">"
              ? val > p.value
              : val < p.value
            : p.missing === "alert"
          : false;

        return {
          subjectKey: subjectKey(a.id),
          subjectJson: JSON.stringify({ agentId: a.id }),
          agent: { id: a.id, name: a.name, group: a.groupName ?? null },
          present,
          cond,
          value: {
            metric: p.metric,
            op: p.op,
            threshold: p.value,
            value: hasValue ? val : null,
            missing: !hasValue,
          },
        };
      });
  },

  describeValue(value: Value): ValueLine[] {
    const displayName = metricDisplayName(value.metric);
    if (value.missing) {
      return [
        { label: "Metric", text: displayName },
        { label: "Current", text: "missing" },
        {
          label: "Condition",
          text: `${value.op} ${formatMetricValue(value.metric, value.threshold)}`,
        },
      ];
    }
    return [
      { label: "Metric", text: displayName },
      { label: "Current", text: formatMetricValue(value.metric, value.value ?? 0) },
      {
        label: "Condition",
        text: `${value.op} ${formatMetricValue(value.metric, value.threshold)}`,
      },
    ];
  },

  extendTemplateVars(value: Value, b: TemplateVarsBuilder): void {
    b.set("metric.key", value.metric);
    b.set("metric.name", metricDisplayName(value.metric));
    b.set(
      "metric.value",
      value.value !== null ? formatMetricValue(value.metric, value.value) : "missing",
    );
    b.set("metric.threshold", formatMetricValue(value.metric, value.threshold));
    b.set("metric.op", value.op);
  },

  sampleValue(): Value {
    return { metric: "cpu.usage_pct", op: ">", threshold: 90, value: 95.2, missing: false };
  },
};
