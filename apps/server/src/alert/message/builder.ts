import type { AlertMessageV1, AlertRuleKind } from "../types";

export function buildMessage(args: {
  kind: AlertMessageV1["kind"];
  severity: AlertMessageV1["severity"];
  rule: { id: string; name: string; kind: AlertRuleKind };
  subjectKey: string;
  agent: { id: string; name: string; group: string | null };
  task?: { id: string; name: string | null };
  value: unknown;
  tsMs: number;
}): AlertMessageV1 {
  return {
    v: 1,
    kind: args.kind,
    severity: args.severity,
    rule: args.rule,
    subject: {
      key: args.subjectKey,
      agent: args.agent,
      ...(args.task ? { task: args.task } : {}),
    },
    value: args.value,
    tsMs: args.tsMs,
  };
}

export function buildSampleMessage(ruleKind?: AlertRuleKind): AlertMessageV1 {
  const nowMs = Date.now();
  const kind = ruleKind ?? "metric_threshold";

  return {
    v: 1,
    kind: "firing",
    severity: "info",
    rule: { id: "test", name: "Test Notification", kind },
    subject: {
      key: "test",
      agent: { id: "test-agent", name: "test-agent", group: null },
    },
    value: { test: true },
    tsMs: nowMs,
  };
}
