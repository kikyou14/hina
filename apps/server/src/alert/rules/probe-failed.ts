import { isRecord, uniqueStrings } from "../../util/lang";
import { round, truncate } from "../message/vars";
import type { ValueLine, TemplateVarsBuilder } from "../message/vars";
import { matchesSelector } from "../selector";
import type { Result, ValidationError } from "../types";
import { err, parseStringArr } from "./shared";
import type { DataBundle, EvalTarget, LoadedRule, PollRuleDefinition } from "./types";

export type ProbeFailedParams = { taskIds: string[] };

type Value = {
  ok: boolean;
  tsMs: number;
  latMs: number | null;
  code: number | null;
  err: string | null;
  updatedAtMs: number;
};

function subjectKey(agentId: string, taskId: string): string {
  return `a:${agentId}|t:${taskId}`;
}

export const probeFailedRule: PollRuleDefinition<ProbeFailedParams, Value> = {
  kind: "probe_failed",
  mode: "poll",

  parseParams(raw: unknown): Result<ProbeFailedParams, ValidationError[]> {
    if (!isRecord(raw)) return err("params", "invalid_params", "params must be an object");
    const taskIds = uniqueStrings(parseStringArr(raw["taskIds"]));
    if (taskIds.length === 0)
      return err("params.taskIds", "missing_task_ids", "at least one taskId is required");
    return { ok: true, value: { taskIds } };
  },

  probeTaskIds(params: ProbeFailedParams): string[] {
    return params.taskIds;
  },

  deriveTargets(bundle: DataBundle, rule: LoadedRule<ProbeFailedParams>): EvalTarget<Value>[] {
    const out: EvalTarget<Value>[] = [];
    for (const a of bundle.agents) {
      if (!matchesSelector(a, rule.selector)) continue;
      for (const taskId of rule.params.taskIds) {
        const key = subjectKey(a.id, taskId);
        const latest = bundle.probeLatestByKey.get(key);

        out.push({
          subjectKey: key,
          subjectJson: JSON.stringify({ agentId: a.id, taskId }),
          agent: { id: a.id, name: a.name, group: a.groupName ?? null },
          task: { id: taskId, name: bundle.probeTaskNameById.get(taskId) ?? null },
          present: latest !== undefined,
          cond: latest !== undefined && latest.ok === false,
          value: latest
            ? {
                ok: latest.ok,
                tsMs: latest.tsMs,
                latMs: latest.latMs,
                code: latest.code,
                err: latest.err,
                updatedAtMs: latest.updatedAtMs,
              }
            : { ok: true, tsMs: 0, latMs: null, code: null, err: null, updatedAtMs: 0 },
        });
      }
    }
    return out;
  },

  describeValue(value: Value): ValueLine[] {
    const lines: ValueLine[] = [];
    lines.push({ label: "Status", text: value.ok === false ? "Failed" : "OK" });
    if (typeof value.code === "number") lines.push({ label: "Code", text: String(value.code) });
    if (typeof value.latMs === "number")
      lines.push({ label: "Latency", text: `${round(value.latMs, 1)}ms` });
    if (typeof value.err === "string" && value.err)
      lines.push({ label: "Error", text: truncate(value.err, 200) });
    return lines;
  },

  extendTemplateVars(value: Value, b: TemplateVarsBuilder): void {
    b.set("probe.status", value.ok === false ? "Failed" : "OK");
    b.set("probe.code", typeof value.code === "number" ? String(value.code) : "");
    b.set("probe.latency", typeof value.latMs === "number" ? `${round(value.latMs, 1)}ms` : "");
    b.set("probe.error", typeof value.err === "string" ? truncate(value.err, 200) : "");
  },

  sampleValue(): Value {
    return {
      ok: false,
      tsMs: Date.now(),
      latMs: null,
      code: null,
      err: "connection refused",
      updatedAtMs: Date.now(),
    };
  },
};
