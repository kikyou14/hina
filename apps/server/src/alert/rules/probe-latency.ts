import { isRecord, uniqueStrings } from "../../util/lang";
import { round, truncate } from "../message/vars";
import type { ValueLine, TemplateVarsBuilder } from "../message/vars";
import { matchesSelector } from "../selector";
import type { Result, ValidationError } from "../types";
import { err, parseStringArr } from "./shared";
import type { DataBundle, EvalTarget, LoadedRule, PollRuleDefinition } from "./types";

export type ProbeLatencyParams = { taskIds: string[]; op: ">" | "<"; value: number };

type Value = {
  ok: boolean;
  tsMs: number;
  latMs: number | null;
  op: string;
  threshold: number;
  code: number | null;
  err: string | null;
  updatedAtMs: number;
};

function subjectKey(agentId: string, taskId: string): string {
  return `a:${agentId}|t:${taskId}`;
}

export const probeLatencyRule: PollRuleDefinition<ProbeLatencyParams, Value> = {
  kind: "probe_latency",
  mode: "poll",

  parseParams(raw: unknown): Result<ProbeLatencyParams, ValidationError[]> {
    if (!isRecord(raw)) return err("params", "invalid_params", "params must be an object");
    const taskIds = uniqueStrings(parseStringArr(raw["taskIds"]));
    if (taskIds.length === 0)
      return err("params.taskIds", "missing_task_ids", "at least one taskId is required");
    const op = raw["op"] === ">" || raw["op"] === "<" ? raw["op"] : null;
    if (!op) return err("params.op", "invalid_op", 'op must be ">" or "<"');
    const value = typeof raw["value"] === "number" ? raw["value"] : Number.NaN;
    if (!Number.isFinite(value) || value < 0)
      return err("params.value", "invalid_value", "value must be a non-negative finite number");
    return { ok: true, value: { taskIds, op, value } };
  },

  probeTaskIds(params: ProbeLatencyParams): string[] {
    return params.taskIds;
  },

  deriveTargets(bundle: DataBundle, rule: LoadedRule<ProbeLatencyParams>): EvalTarget<Value>[] {
    const p = rule.params;
    const out: EvalTarget<Value>[] = [];
    for (const a of bundle.agents) {
      if (!matchesSelector(a, rule.selector)) continue;
      for (const taskId of p.taskIds) {
        const key = subjectKey(a.id, taskId);
        const latest = bundle.probeLatestByKey.get(key);

        // present=false when no data OR when the latest result is a failure
        // (probe_latency only evaluates successful probe results for latency)
        const hasLatency =
          latest !== undefined &&
          latest.ok &&
          typeof latest.latMs === "number" &&
          Number.isFinite(latest.latMs);
        const present = hasLatency;
        const cond =
          present && (p.op === ">" ? latest!.latMs! > p.value : latest!.latMs! < p.value);

        out.push({
          subjectKey: key,
          subjectJson: JSON.stringify({ agentId: a.id, taskId }),
          agent: { id: a.id, name: a.name, group: a.groupName ?? null },
          task: { id: taskId, name: bundle.probeTaskNameById.get(taskId) ?? null },
          present,
          cond,
          value: latest
            ? {
                ok: latest.ok,
                tsMs: latest.tsMs,
                latMs: latest.latMs,
                op: p.op,
                threshold: p.value,
                code: latest.code,
                err: latest.err,
                updatedAtMs: latest.updatedAtMs,
              }
            : {
                ok: true,
                tsMs: 0,
                latMs: null,
                op: p.op,
                threshold: p.value,
                code: null,
                err: null,
                updatedAtMs: 0,
              },
        });
      }
    }
    return out;
  },

  describeValue(value: Value): ValueLine[] {
    return [
      {
        label: "Latency",
        text: typeof value.latMs === "number" ? `${round(value.latMs, 1)}ms` : "N/A",
      },
      { label: "Condition", text: `${value.op} ${round(value.threshold, 1)}ms` },
    ];
  },

  extendTemplateVars(value: Value, b: TemplateVarsBuilder): void {
    b.set("probe.status", value.ok === false ? "Failed" : "OK");
    b.set("probe.code", typeof value.code === "number" ? String(value.code) : "");
    b.set("probe.latency", typeof value.latMs === "number" ? `${round(value.latMs, 1)}ms` : "");
    b.set("probe.error", typeof value.err === "string" ? truncate(value.err, 200) : "");
    b.set("probe.threshold", `${value.op} ${round(value.threshold, 1)}ms`);
  },

  sampleValue(): Value {
    return {
      ok: true,
      tsMs: Date.now(),
      latMs: 350,
      op: ">",
      threshold: 200,
      code: 200,
      err: null,
      updatedAtMs: Date.now(),
    };
  },
};
