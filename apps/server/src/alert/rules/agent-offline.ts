import { formatDuration } from "../message/vars";
import type { ValueLine, TemplateVarsBuilder } from "../message/vars";
import { matchesSelector } from "../selector";
import type { Result, ValidationError } from "../types";
import type { DataBundle, EvalTarget, LoadedRule, PollRuleDefinition } from "./types";

type Params = Record<string, never>;

type Value = {
  offline: boolean;
  lastSeenAtMs: number | null;
  offlineForMs: number | null;
};

function subjectKey(agentId: string): string {
  return `a:${agentId}`;
}

export const agentOfflineRule: PollRuleDefinition<Params, Value> = {
  kind: "agent_offline",
  mode: "poll",

  parseParams(): Result<Params, ValidationError[]> {
    return { ok: true, value: {} };
  },

  deriveTargets(bundle: DataBundle, rule: LoadedRule<Params>, nowMs: number): EvalTarget<Value>[] {
    return bundle.agents
      .filter((a) => matchesSelector(a, rule.selector))
      .map((a) => {
        const lastSeenAtMs = a.lastSeenAtMs ?? 0;
        const offlineForMs = lastSeenAtMs > 0 ? Math.max(0, nowMs - lastSeenAtMs) : null;
        const cond = lastSeenAtMs <= 0 || nowMs - lastSeenAtMs > bundle.missedHeartbeatGraceMs;

        return {
          subjectKey: subjectKey(a.id),
          subjectJson: JSON.stringify({ agentId: a.id }),
          agent: { id: a.id, name: a.name, group: a.groupName ?? null },
          present: true,
          cond,
          value: { offline: cond, lastSeenAtMs: a.lastSeenAtMs ?? null, offlineForMs },
        };
      });
  },

  describeValue(value: Value): ValueLine[] {
    if (value.offline && value.offlineForMs !== null) {
      return [{ label: "Status", text: `Offline for ${formatDuration(value.offlineForMs)}` }];
    }
    return [{ label: "Status", text: value.offline ? "Offline" : "Online" }];
  },

  extendTemplateVars(value: Value, b: TemplateVarsBuilder): void {
    b.set(
      "offline.duration",
      value.offlineForMs !== null ? formatDuration(value.offlineForMs) : "",
    );
  },

  sampleValue(): Value {
    return { offline: true, lastSeenAtMs: Date.now() - 120_000, offlineForMs: 120_000 };
  },
};
