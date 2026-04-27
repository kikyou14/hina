import { isRecord } from "../../util/lang";
import { formatPlainText, formatSubjectLine } from "../message/format-plain";
import { renderTemplate } from "../message/template";
import { buildTemplateVars } from "../message/vars";
import type { Result, ValidationError } from "../types";
import { err, resolveOptStr } from "./shared";
import type { Notifier, SendContext, SendResult } from "./types";
import { withTimeout } from "./types";

export type ServerChanTurboChannelConfig = {
  sendKey: string;
  channel?: string;
  messageTemplate?: string;
};

export const serverChanTurboNotifier: Notifier<ServerChanTurboChannelConfig> = {
  type: "serverchanturbo",

  parseConfig(
    raw: unknown,
    existing?: ServerChanTurboChannelConfig,
  ): Result<ServerChanTurboChannelConfig, ValidationError[]> {
    if (!isRecord(raw)) raw = {};
    const obj = raw as Record<string, unknown>;

    const sendKeyRaw = typeof obj["sendKey"] === "string" ? obj["sendKey"].trim() : "";
    const sendKey = sendKeyRaw || existing?.sendKey || "";
    if (!sendKey) return err("config.sendKey", "missing_send_key", "sendKey is required");

    const channelRaw = typeof obj["channel"] === "string" ? obj["channel"].trim() : undefined;
    const channel = channelRaw !== undefined ? channelRaw : existing?.channel;
    const messageTemplate = resolveOptStr(obj, "messageTemplate", existing?.messageTemplate);

    return {
      ok: true,
      value: { sendKey, channel: channel || undefined, messageTemplate },
    };
  },

  redactConfig(config: ServerChanTurboChannelConfig) {
    return {
      config: {
        hasSendKey: typeof config.sendKey === "string" && config.sendKey.length > 0,
        channel: config.channel ?? null,
        messageTemplate: config.messageTemplate ?? null,
      },
      meta: {},
    };
  },

  async send(ctx: SendContext, config: ServerChanTurboChannelConfig): Promise<SendResult> {
    const url = `https://sctapi.ftqq.com/${encodeURIComponent(config.sendKey)}.send`;

    const desp = config.messageTemplate
      ? renderTemplate(config.messageTemplate, buildTemplateVars(ctx.message, ctx.publicBaseUrl))
      : formatPlainText(ctx.message);

    const body: Record<string, string> = {
      title: formatSubjectLine(ctx.message),
      desp,
    };
    if (config.channel) body["channel"] = config.channel;

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
          error: `serverchanturbo non-2xx: ${resp.status} ${respText}`.trim(),
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
