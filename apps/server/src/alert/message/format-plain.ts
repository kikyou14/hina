import type { AlertMessageV1 } from "../types";
import { describeValue, formatTimestamp } from "./vars";

export function formatSubjectLine(msg: AlertMessageV1): string {
  const prefix = msg.kind === "firing" ? "ALERT" : "RECOVERED";
  const sev = msg.severity.toUpperCase();
  return `${prefix} [${sev}] ${msg.rule.name}`;
}

export function formatPlainText(msg: AlertMessageV1): string {
  const icon = msg.kind === "firing" ? "\u{1f534}" : "\u2705";
  const lines: string[] = [];
  lines.push(`${icon} ${formatSubjectLine(msg)}`);
  lines.push("");
  lines.push(`Agent: ${msg.subject.agent.name}`);
  if (msg.subject.agent.group) lines.push(`Group: ${msg.subject.agent.group}`);
  if (msg.subject.task) lines.push(`Task: ${msg.subject.task.name ?? msg.subject.task.id}`);

  for (const { label, text } of describeValue(msg)) {
    lines.push(`${label}: ${text}`);
  }

  lines.push(`Time: ${formatTimestamp(msg.tsMs)}`);
  return lines.join("\n");
}
