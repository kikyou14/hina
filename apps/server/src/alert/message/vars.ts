import { resolveRule } from "../rules/registry";
import type { AlertMessageV1 } from "../types";
import { TemplateVarsBuilder, formatTimestamp, type ValueLine } from "./format";
import { escHtml, escMarkdownV2, type TemplateVars } from "./template";

export {
  formatAsPath,
  formatBytes,
  formatBytesRate,
  formatDuration,
  formatMetricValue,
  formatTimestamp,
  metricDisplayName,
  round,
  setAlertTimezoneProvider,
  TemplateVarsBuilder,
  truncate,
  type ValueLine,
  yyyyMmDdToDisplay,
} from "./format";

export function describeValueRaw(kind: string, value: unknown): ValueLine[] {
  const rule = resolveRule(kind);
  if (!rule) return [];
  return rule.describeValue(value);
}

function detailsPlain(lines: ValueLine[]): string {
  return lines.map((l) => `${l.label}: ${l.text}`).join("\n");
}

function detailsHtml(lines: ValueLine[]): string {
  return lines.map((l) => `<b>${escHtml(l.label)}:</b> ${escHtml(l.text)}`).join("\n");
}

function detailsMd(lines: ValueLine[]): string {
  return lines.map((l) => `*${escMarkdownV2(l.label)}:* ${escMarkdownV2(l.text)}`).join("\n");
}

function populateFromMessage(
  b: TemplateVarsBuilder,
  msg: AlertMessageV1,
  publicBaseUrl?: string,
): void {
  const lines = describeValueRaw(msg.rule.kind, msg.value);

  b.set("status", msg.kind === "firing" ? "ALERT" : "RECOVERED");
  b.set("icon", msg.kind === "firing" ? "\u{1f534}" : "\u2705");
  b.set("severity", msg.severity.toUpperCase());
  b.set("rule.name", msg.rule.name);
  b.set("rule.kind", msg.rule.kind);
  b.set("agent.name", msg.subject.agent.name);
  b.set("agent.id", msg.subject.agent.id);
  b.set("agent.group", msg.subject.agent.group ?? "");
  b.set("task.name", msg.subject.task?.name ?? msg.subject.task?.id ?? "");
  b.set("time", formatTimestamp(msg.tsMs));
  b.set("details", detailsPlain(lines));
  b.setRaw("details.html", detailsHtml(lines));
  b.setRaw("details.md", detailsMd(lines));

  const base = publicBaseUrl?.replace(/\/+$/, "") ?? "";
  b.setRaw("dashboard.url", base ? `${base}/agents/${msg.subject.agent.id}` : "");
}

function extendPerKind(b: TemplateVarsBuilder, msg: AlertMessageV1): void {
  const rule = resolveRule(msg.rule.kind);
  if (rule) rule.extendTemplateVars(msg.value, b);
}

export function buildTemplateVars(msg: AlertMessageV1, publicBaseUrl?: string): TemplateVars {
  const b = new TemplateVarsBuilder();
  populateFromMessage(b, msg, publicBaseUrl);
  extendPerKind(b, msg);
  return b.build();
}

export function formatValueSummary(kind: string, value: unknown): string {
  return detailsPlain(describeValueRaw(kind, value));
}

export function describeValue(msg: AlertMessageV1): ValueLine[] {
  return describeValueRaw(msg.rule.kind, msg.value);
}
