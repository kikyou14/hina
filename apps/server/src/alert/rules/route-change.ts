import type { RouteChangeEvent } from "../../ingest/traceroute";
import { isRecord, uniqueStrings } from "../../util/lang";
import { ROUTE_CHANGE_COOLDOWN_MS } from "../constants";
import { formatAsPath } from "../message/format";
import type { TemplateVarsBuilder, ValueLine } from "../message/format";
import { matchesSelector } from "../selector";
import type { Result, ValidationError } from "../types";
import { err, parseStringArr } from "./shared";
import type { EventRuleDefinition, EvalTarget, LoadedRule } from "./types";

export type { RouteChangeEvent };

export type RouteChangeParams = { taskIds: string[] };

type Value = {
  signature: string;
  prevSignature: string;
};

function subjectKey(agentId: string, taskId: string): string {
  return `a:${agentId}|t:${taskId}`;
}

export const routeChangeRule: EventRuleDefinition<RouteChangeParams, Value, RouteChangeEvent> = {
  kind: "route_change",
  mode: "event",
  cooldownMs: ROUTE_CHANGE_COOLDOWN_MS,

  parseParams(raw: unknown): Result<RouteChangeParams, ValidationError[]> {
    if (!isRecord(raw)) return err("params", "invalid_params", "params must be an object");
    const taskIds = uniqueStrings(parseStringArr(raw["taskIds"]));
    if (taskIds.length === 0)
      return err("params.taskIds", "missing_task_ids", "at least one taskId is required");
    return { ok: true, value: { taskIds } };
  },

  matchEvent(
    rule: LoadedRule<RouteChangeParams>,
    event: RouteChangeEvent,
    agentInfo: { id: string; name: string; groupId: string | null; groupName: string | null },
    taskName: string | null,
  ): EvalTarget<Value> | null {
    if (!rule.params.taskIds.includes(event.taskId)) return null;
    if (!matchesSelector(agentInfo, rule.selector)) return null;

    return {
      subjectKey: subjectKey(event.agentId, event.taskId),
      subjectJson: JSON.stringify({ agentId: event.agentId, taskId: event.taskId }),
      agent: { id: agentInfo.id, name: agentInfo.name, group: agentInfo.groupName ?? null },
      task: { id: event.taskId, name: taskName },
      present: true,
      cond: true,
      value: { signature: event.signature, prevSignature: event.prevSignature },
    };
  },

  describeValue(value: Value): ValueLine[] {
    return [
      { label: "Previous Route", text: formatAsPath(value.prevSignature) },
      { label: "Current Route", text: formatAsPath(value.signature) },
    ];
  },

  extendTemplateVars(value: Value, b: TemplateVarsBuilder): void {
    b.set("route.prev", formatAsPath(value.prevSignature));
    b.set("route.current", formatAsPath(value.signature));
  },

  sampleValue(): Value {
    return { signature: "4134,6939,13335", prevSignature: "4134,174,13335" };
  },
};
