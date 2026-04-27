import type { AlertMessageV1 } from "../types";
import type { TemplateVars } from "./template";
import { escHtml } from "./template";
import { buildTemplateVars } from "./vars";

export function formatTelegramHtml(msg: AlertMessageV1, vars?: TemplateVars): string {
  const v = vars ?? buildTemplateVars(msg);
  const get = (key: string) => v.values[key] ?? "";

  const lines: string[] = [];
  lines.push(
    `${get("icon")} <b>${escHtml(get("status"))} [${escHtml(get("severity"))}] ${escHtml(get("rule.name"))}</b>`,
  );
  lines.push("");
  lines.push(`<b>Agent:</b> ${escHtml(get("agent.name"))}`);
  if (get("agent.group")) lines.push(`<b>Group:</b> ${escHtml(get("agent.group"))}`);
  if (get("task.name")) lines.push(`<b>Task:</b> ${escHtml(get("task.name"))}`);
  lines.push(get("details.html"));
  lines.push(`<b>Time:</b> ${escHtml(get("time"))}`);
  return lines.join("\n");
}
