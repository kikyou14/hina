import { isRecord } from "../../util/lang";
import { formatPlainText, formatSubjectLine } from "../message/format-plain";
import { renderTemplate } from "../message/template";
import { buildTemplateVars } from "../message/vars";
import type { Result, ValidationError } from "../types";
import { err, resolveOptStr } from "./shared";
import type { Notifier, SendContext, SendResult } from "./types";
import { withTimeout } from "./types";

export type ServerChan3ChannelConfig = {
  sendKey: string;
  tags?: string;
  short?: string;
  messageTemplate?: string;
};

const SC3_UID_RE = /^sctp(\d+)t/;

export const serverChan3Notifier: Notifier<ServerChan3ChannelConfig> = {
  type: "serverchan3",

  parseConfig(
    raw: unknown,
    existing?: ServerChan3ChannelConfig,
  ): Result<ServerChan3ChannelConfig, ValidationError[]> {
    if (!isRecord(raw)) raw = {};
    const obj = raw as Record<string, unknown>;

    const sendKeyRaw = typeof obj["sendKey"] === "string" ? obj["sendKey"].trim() : "";
    const sendKey = sendKeyRaw || existing?.sendKey || "";
    if (!sendKey) return err("config.sendKey", "missing_send_key", "sendKey is required");

    const tags = resolveOptStr(obj, "tags", existing?.tags);
    const short = resolveOptStr(obj, "short", existing?.short);
    const messageTemplate = resolveOptStr(obj, "messageTemplate", existing?.messageTemplate);

    return {
      ok: true,
      value: { sendKey, tags: tags || undefined, short: short || undefined, messageTemplate },
    };
  },

  redactConfig(config: ServerChan3ChannelConfig) {
    return {
      config: {
        hasSendKey: typeof config.sendKey === "string" && config.sendKey.length > 0,
        tags: config.tags ?? null,
        short: config.short ?? null,
        messageTemplate: config.messageTemplate ?? null,
      },
      meta: {},
    };
  },

  async send(ctx: SendContext, config: ServerChan3ChannelConfig): Promise<SendResult> {
    const uid = SC3_UID_RE.exec(config.sendKey)?.[1];
    if (!uid) return { kind: "fatal", error: "serverchan3: cannot extract uid from sendKey" };

    const url = `https://${uid}.push.ft07.com/send/${encodeURIComponent(config.sendKey)}.send`;

    const desp = config.messageTemplate
      ? renderTemplate(config.messageTemplate, buildTemplateVars(ctx.message, ctx.publicBaseUrl))
      : formatPlainText(ctx.message);

    const body: Record<string, string> = {
      title: formatSubjectLine(ctx.message),
      desp,
    };
    if (config.tags) body["tags"] = config.tags;
    if (config.short) body["short"] = config.short;

    const { signal, cancel } = withTimeout(10_000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        const respText = await resp.text().catch(() => "");
        return {
          kind: "retryable",
          error: `serverchan3 non-2xx: ${resp.status} ${respText}`.trim(),
        };
      }
      return { kind: "ok" };
    } catch (e) {
      return { kind: "retryable", error: String(e instanceof Error ? e.message : e) };
    } finally {
      cancel();
    }
  },
};
