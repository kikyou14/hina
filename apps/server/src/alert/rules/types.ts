import type { AgentAlertView } from "../../agents/registry";
import type { TemplateVarsBuilder, ValueLine } from "../message/format";
import type { AgentSelector } from "../selector";
import type { AlertRuleKind, AlertSeverity, Result, ValidationError } from "../types";

export type LoadedRule<TParams = unknown> = {
  id: string;
  name: string;
  enabled: boolean;
  severity: AlertSeverity;
  kind: AlertRuleKind;
  selector: AgentSelector;
  params: TParams;
  forMs: number;
  recoverMs: number;
  notifyOnRecovery: boolean;
  updatedAtMs: number;
};

export type EvalTarget<TValue = unknown> = {
  subjectKey: string;
  subjectJson: string;
  agent: { id: string; name: string; group: string | null };
  task?: { id: string; name: string | null };
  present: boolean;
  cond: boolean;
  value: TValue;
};

export type ProbeLatestRow = {
  agentId: string;
  taskId: string;
  tsMs: number;
  ok: boolean;
  latMs: number | null;
  code: number | null;
  err: string | null;
  updatedAtMs: number;
};

export type DataBundle = {
  agents: AgentAlertView[];
  probeLatestByKey: Map<string, ProbeLatestRow>;
  probeTaskNameById: Map<string, string>;
  metricsStaleMs: number;
  missedHeartbeatGraceMs: number;
};

type BaseRuleDefinition<TParams, TValue> = {
  readonly kind: AlertRuleKind;
  parseParams(raw: unknown, existing?: TParams): Result<TParams, ValidationError[]>;
  describeValue(value: TValue): ValueLine[];
  extendTemplateVars(value: TValue, builder: TemplateVarsBuilder): void;
  sampleValue(): TValue;
};

export type PollRuleDefinition<TParams = unknown, TValue = unknown> = BaseRuleDefinition<
  TParams,
  TValue
> & {
  readonly mode: "poll";
  probeTaskIds?(params: TParams): string[];
  deriveTargets(bundle: DataBundle, rule: LoadedRule<TParams>, nowMs: number): EvalTarget<TValue>[];
};

export type EventRuleDefinition<
  TParams = unknown,
  TValue = unknown,
  TEvent = unknown,
> = BaseRuleDefinition<TParams, TValue> & {
  readonly mode: "event";
  readonly cooldownMs: number;
  matchEvent(
    rule: LoadedRule<TParams>,
    event: TEvent,
    agentInfo: { id: string; name: string; groupId: string | null; groupName: string | null },
    taskName: string | null,
  ): EvalTarget<TValue> | null;
};

export type RuleDefinition =
  | PollRuleDefinition<unknown, unknown>
  | EventRuleDefinition<unknown, unknown, unknown>;
