import type { AlertMessageV1 } from "../types";
import { escHtml } from "./template";
import { describeValue, formatTimestamp } from "./vars";

export function formatEmailHtml(msg: AlertMessageV1): string {
  const icon = msg.kind === "firing" ? "\u{1f534}" : "\u2705";
  const prefix = msg.kind === "firing" ? "ALERT" : "RECOVERED";
  const sev = msg.severity.toUpperCase();

  const rows: string[] = [];
  rows.push(
    `<tr><td style="padding:4px 8px;font-weight:bold">Agent</td><td style="padding:4px 8px">${escHtml(msg.subject.agent.name)}</td></tr>`,
  );
  if (msg.subject.agent.group)
    rows.push(
      `<tr><td style="padding:4px 8px;font-weight:bold">Group</td><td style="padding:4px 8px">${escHtml(msg.subject.agent.group)}</td></tr>`,
    );
  if (msg.subject.task)
    rows.push(
      `<tr><td style="padding:4px 8px;font-weight:bold">Task</td><td style="padding:4px 8px">${escHtml(msg.subject.task.name ?? msg.subject.task.id)}</td></tr>`,
    );
  for (const { label, text } of describeValue(msg)) {
    rows.push(
      `<tr><td style="padding:4px 8px;font-weight:bold">${escHtml(label)}</td><td style="padding:4px 8px">${escHtml(text)}</td></tr>`,
    );
  }
  rows.push(
    `<tr><td style="padding:4px 8px;font-weight:bold">Time</td><td style="padding:4px 8px">${escHtml(formatTimestamp(msg.tsMs))}</td></tr>`,
  );

  return `<div style="font-family:sans-serif;max-width:600px">
<h2>${icon} ${escHtml(prefix)} [${escHtml(sev)}] ${escHtml(msg.rule.name)}</h2>
<table style="border-collapse:collapse">${rows.join("")}</table>
</div>`;
}
