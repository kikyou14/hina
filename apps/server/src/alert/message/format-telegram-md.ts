import type { AlertMessageV1 } from "../types";
import type { TemplateVars } from "./template";
import { escMarkdownV2 } from "./template";
import { buildTemplateVars } from "./vars";

export function formatTelegramMarkdownV2(msg: AlertMessageV1, vars?: TemplateVars): string {
  const v = vars ?? buildTemplateVars(msg);
  const get = (key: string) => v.values[key] ?? "";
  const e = escMarkdownV2;

  const lines: string[] = [];
  lines.push(
    `${get("icon")} *${e(get("status"))} \\[${e(get("severity"))}\\] ${e(get("rule.name"))}*`,
  );
  lines.push("");
  lines.push(`*Agent:* ${e(get("agent.name"))}`);
  if (get("agent.group")) lines.push(`*Group:* ${e(get("agent.group"))}`);
  if (get("task.name")) lines.push(`*Task:* ${e(get("task.name"))}`);
  lines.push(get("details.md"));
  lines.push(`*Time:* ${e(get("time"))}`);
  return lines.join("\n");
}
