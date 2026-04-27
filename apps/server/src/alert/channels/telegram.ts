import { isRecord } from "../../util/lang";
import { isPublicHttpUrl } from "../../util/url";
import { formatTelegramHtml } from "../message/format-telegram-html";
import { formatTelegramMarkdownV2 } from "../message/format-telegram-md";
import type { TemplateVars } from "../message/template";
import { escHtml, escMarkdownV2, renderTemplate } from "../message/template";
import { buildTemplateVars } from "../message/vars";
import type { Result, ValidationError } from "../types";
import { err, resolveOptStr } from "./shared";
import type { Notifier, SendContext, SendResult } from "./types";
import { withTimeout } from "./types";

export type TelegramParseMode = "HTML" | "MarkdownV2";

export type TelegramButton = { text: string; url: string };

export type TelegramChannelConfig = {
  botToken: string;
  chatId: string;
  disableNotification?: boolean;
  messageThreadId?: number;
  parseMode?: TelegramParseMode;
  messageTemplate?: string;
  buttons?: TelegramButton[];
};

export const telegramNotifier: Notifier<TelegramChannelConfig> = {
  type: "telegram",

  parseConfig(
    raw: unknown,
    existing?: TelegramChannelConfig,
  ): Result<TelegramChannelConfig, ValidationError[]> {
    if (!isRecord(raw)) raw = {};
    const obj = raw as Record<string, unknown>;

    const botTokenRaw = typeof obj["botToken"] === "string" ? obj["botToken"].trim() : "";
    const botToken = botTokenRaw || existing?.botToken || "";
    if (!botToken) return err("config.botToken", "missing_bot_token", "botToken is required");

    const chatIdRaw = typeof obj["chatId"] === "string" ? obj["chatId"].trim() : "";
    const chatId = chatIdRaw || existing?.chatId || "";
    if (!chatId) return err("config.chatId", "missing_chat_id", "chatId is required");

    const disableNotification =
      typeof obj["disableNotification"] === "boolean"
        ? obj["disableNotification"]
        : existing?.disableNotification;

    const messageThreadIdRaw =
      typeof obj["messageThreadId"] === "number" ? obj["messageThreadId"] : undefined;
    const messageThreadId =
      messageThreadIdRaw !== undefined &&
      Number.isFinite(messageThreadIdRaw) &&
      Number.isInteger(messageThreadIdRaw) &&
      messageThreadIdRaw > 0
        ? messageThreadIdRaw
        : existing?.messageThreadId;

    const parseModeRaw = typeof obj["parseMode"] === "string" ? obj["parseMode"] : undefined;
    const parseMode: TelegramParseMode | undefined =
      parseModeRaw === "MarkdownV2"
        ? "MarkdownV2"
        : parseModeRaw === "HTML"
          ? "HTML"
          : existing?.parseMode;

    const messageTemplate = resolveOptStr(obj, "messageTemplate", existing?.messageTemplate);

    const buttonsRaw = Array.isArray(obj["buttons"]) ? obj["buttons"] : undefined;
    let buttons: TelegramButton[] | undefined;
    if (buttonsRaw !== undefined) {
      buttons = [];
      for (const b of buttonsRaw) {
        if (!isRecord(b)) continue;
        const text = typeof b["text"] === "string" ? b["text"].trim() : "";
        const url = typeof b["url"] === "string" ? b["url"].trim() : "";
        if (text && url && buttons.length < 8) buttons.push({ text, url });
      }
      if (buttons.length === 0) buttons = undefined;
    } else {
      buttons = existing?.buttons;
    }

    return {
      ok: true,
      value: {
        botToken,
        chatId,
        disableNotification,
        messageThreadId,
        parseMode,
        messageTemplate,
        buttons,
      },
    };
  },

  redactConfig(config: TelegramChannelConfig) {
    const buttons = config.buttons && config.buttons.length > 0 ? config.buttons : null;
    return {
      config: {
        chatId: config.chatId,
        disableNotification: config.disableNotification ?? null,
        messageThreadId: config.messageThreadId ?? null,
        hasBotToken: typeof config.botToken === "string" && config.botToken.length > 0,
        parseMode: config.parseMode ?? null,
        messageTemplate: config.messageTemplate ?? null,
        buttons,
      },
      meta: {},
    };
  },

  async send(ctx: SendContext, config: TelegramChannelConfig): Promise<SendResult> {
    const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    const vars = buildTemplateVars(ctx.message, ctx.publicBaseUrl);
    const text = buildMessageText(config, vars, ctx);
    const parseMode = config.parseMode === "MarkdownV2" ? "MarkdownV2" : "HTML";

    const payload: Record<string, unknown> = {
      chat_id: config.chatId,
      text,
      parse_mode: parseMode,
      disable_notification: config.disableNotification ?? false,
    };
    if (config.messageThreadId) payload["message_thread_id"] = config.messageThreadId;

    const replyMarkup = buildReplyMarkup(config, vars);
    if (replyMarkup) payload["reply_markup"] = replyMarkup;

    const { signal, cancel } = withTimeout(10_000);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      if (!resp.ok) {
        const respText = await resp.text().catch(() => "");
        return { kind: "retryable", error: `telegram non-2xx: ${resp.status} ${respText}`.trim() };
      }
      return { kind: "ok" };
    } catch (e) {
      return { kind: "retryable", error: String(e instanceof Error ? e.message : e) };
    } finally {
      cancel();
    }
  },
};

function buildMessageText(
  config: TelegramChannelConfig,
  vars: TemplateVars,
  ctx: SendContext,
): string {
  const useMarkdown = config.parseMode === "MarkdownV2";
  const template = config.messageTemplate?.trim();

  if (!template) {
    return useMarkdown
      ? formatTelegramMarkdownV2(ctx.message, vars)
      : formatTelegramHtml(ctx.message, vars);
  }

  const escFn = useMarkdown ? escMarkdownV2 : escHtml;
  return renderTemplate(template, vars, escFn);
}

function buildReplyMarkup(
  config: TelegramChannelConfig,
  vars: TemplateVars,
): Record<string, unknown> | undefined {
  if (!config.buttons || config.buttons.length === 0) return undefined;

  const buttons = config.buttons.map((b) => ({
    text: renderTemplate(b.text, vars),
    url: renderTemplate(b.url, vars),
  }));

  const valid = buttons.filter((b) => b.text && isPublicHttpUrl(b.url));
  if (valid.length === 0) return undefined;

  return { inline_keyboard: [valid] };
}
