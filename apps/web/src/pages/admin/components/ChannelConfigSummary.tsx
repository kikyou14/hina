import { isRecord } from "@/lib/typeGuards";

export function ChannelConfigSummary(props: { type: string; config: unknown }) {
  const cfg = isRecord(props.config) ? props.config : {};

  if (props.type === "telegram") {
    const parts: string[] = [];
    if (typeof cfg["chatId"] === "string") parts.push(`Chat: ${cfg["chatId"]}`);
    if (typeof cfg["parseMode"] === "string") parts.push(cfg["parseMode"] as string);
    if (typeof cfg["messageTemplate"] === "string" && cfg["messageTemplate"])
      parts.push("custom template");
    const buttons = Array.isArray(cfg["buttons"]) ? cfg["buttons"].length : 0;
    if (buttons > 0) parts.push(`${buttons} button${buttons > 1 ? "s" : ""}`);
    return <span>{parts.join(" \u00b7 ") || "\u2014"}</span>;
  }

  const hasTemplate = typeof cfg["messageTemplate"] === "string" && !!cfg["messageTemplate"];

  if (props.type === "webhook") {
    const method = typeof cfg["method"] === "string" ? cfg["method"] : "POST";
    const url = typeof cfg["url"] === "string" ? (cfg["url"] as string) : "";
    const display = url.length > 50 ? `${url.slice(0, 50)}...` : url;
    const parts: string[] = [];
    if (display) parts.push(`${method} ${display}`);
    if (hasTemplate) parts.push("custom template");
    return <span>{parts.join(" \u00b7 ") || "\u2014"}</span>;
  }

  if (props.type === "email") {
    const host = typeof cfg["host"] === "string" ? (cfg["host"] as string) : "";
    const to = typeof cfg["to"] === "string" ? (cfg["to"] as string) : "";
    const display = to.length > 40 ? `${to.slice(0, 40)}...` : to;
    const parts: string[] = [];
    if (host && display) parts.push(`${host} \u2192 ${display}`);
    else if (host) parts.push(host);
    if (hasTemplate) parts.push("custom template");
    return <span>{parts.join(" \u00b7 ") || "\u2014"}</span>;
  }

  if (props.type === "serverchan3") {
    const parts: string[] = [];
    if (cfg["hasSendKey"]) parts.push("key configured");
    if (typeof cfg["tags"] === "string" && cfg["tags"]) parts.push(`tags: ${cfg["tags"]}`);
    if (hasTemplate) parts.push("custom template");
    return <span>{parts.join(" \u00b7 ") || "\u2014"}</span>;
  }

  if (props.type === "serverchanturbo") {
    const parts: string[] = [];
    if (cfg["hasSendKey"]) parts.push("key configured");
    if (typeof cfg["channel"] === "string" && cfg["channel"]) parts.push(`ch: ${cfg["channel"]}`);
    if (hasTemplate) parts.push("custom template");
    return <span>{parts.join(" \u00b7 ") || "\u2014"}</span>;
  }

  if (props.type === "bark") {
    const parts: string[] = [];
    const serverUrl = typeof cfg["serverUrl"] === "string" ? (cfg["serverUrl"] as string) : "";
    if (serverUrl) parts.push(serverUrl.length > 30 ? `${serverUrl.slice(0, 30)}...` : serverUrl);
    if (typeof cfg["level"] === "string" && cfg["level"]) parts.push(cfg["level"] as string);
    if (typeof cfg["group"] === "string" && cfg["group"]) parts.push(cfg["group"] as string);
    if (hasTemplate) parts.push("custom template");
    return <span>{parts.join(" \u00b7 ") || "\u2014"}</span>;
  }

  return <span>{"\u2014"}</span>;
}
