import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { isRecord } from "../../util/lang";
import { formatEmailHtml } from "../message/format-email-html";
import { formatPlainText, formatSubjectLine } from "../message/format-plain";
import { escHtml, renderTemplate } from "../message/template";
import { buildTemplateVars } from "../message/vars";
import type { Result, ValidationError } from "../types";
import { err, resolveOptStr } from "./shared";
import type { Notifier, SendContext, SendResult } from "./types";

export type EmailChannelConfig = {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
  subjectPrefix?: string;
  timeoutMs?: number;
  messageTemplate?: string;
};

type CachedTransport = {
  transport: Transporter;
  createdAt: number;
  passHash: string;
  secure: boolean | undefined;
};

const transportCache = new Map<string, CachedTransport>();
const TRANSPORT_TTL_MS = 10 * 60 * 1000; // 10 min

function getOrCreateTransport(config: EmailChannelConfig): Transporter {
  const key = `${config.host}:${config.port}:${config.user ?? ""}`;
  const passHash = config.pass ? Bun.hash(config.pass).toString(36) : "";
  const cached = transportCache.get(key);

  if (cached && Date.now() - cached.createdAt < TRANSPORT_TTL_MS) {
    if (cached.passHash === passHash && cached.secure === config.secure) {
      return cached.transport;
    }
    cached.transport.close();
  }

  const secure = config.secure ?? config.port === 465;
  const auth = config.user && config.pass ? { user: config.user, pass: config.pass } : undefined;
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure,
    auth,
    connectionTimeout: config.timeoutMs ?? 10_000,
    greetingTimeout: config.timeoutMs ?? 10_000,
    socketTimeout: config.timeoutMs ?? 10_000,
  });
  transportCache.set(key, { transport, createdAt: Date.now(), passHash, secure: config.secure });
  return transport;
}

export const emailNotifier: Notifier<EmailChannelConfig> = {
  type: "email",

  parseConfig(
    raw: unknown,
    existing?: EmailChannelConfig,
  ): Result<EmailChannelConfig, ValidationError[]> {
    if (!isRecord(raw)) raw = {};
    const obj = raw as Record<string, unknown>;

    const host = typeof obj["host"] === "string" ? obj["host"].trim() : (existing?.host ?? "");
    if (!host) return err("config.host", "missing_host", "host is required");

    const portRaw = typeof obj["port"] === "number" ? obj["port"] : (existing?.port ?? 587);
    const port =
      Number.isFinite(portRaw) && Number.isInteger(portRaw) && portRaw > 0 && portRaw <= 65535
        ? portRaw
        : 587;

    const secure = typeof obj["secure"] === "boolean" ? obj["secure"] : existing?.secure;

    const userRaw = typeof obj["user"] === "string" ? obj["user"].trim() : undefined;
    const user = userRaw !== undefined ? userRaw : existing?.user;

    const passRaw = typeof obj["pass"] === "string" ? obj["pass"] : undefined;
    const pass = passRaw !== undefined ? passRaw : existing?.pass;

    const from = typeof obj["from"] === "string" ? obj["from"].trim() : (existing?.from ?? "");
    if (!from) return err("config.from", "missing_from", "from address is required");

    const to = typeof obj["to"] === "string" ? obj["to"].trim() : (existing?.to ?? "");
    if (!to) return err("config.to", "missing_to", "to address is required");

    const subjectPrefixRaw =
      typeof obj["subjectPrefix"] === "string" ? obj["subjectPrefix"] : undefined;
    const subjectPrefix =
      subjectPrefixRaw !== undefined ? subjectPrefixRaw : existing?.subjectPrefix;

    const timeoutMsRaw =
      typeof obj["timeoutMs"] === "number" ? obj["timeoutMs"] : (existing?.timeoutMs ?? 10_000);
    const timeoutMs =
      Number.isFinite(timeoutMsRaw) && Number.isInteger(timeoutMsRaw)
        ? Math.min(Math.max(timeoutMsRaw, 500), 120_000)
        : 10_000;

    const messageTemplate = resolveOptStr(obj, "messageTemplate", existing?.messageTemplate);

    return {
      ok: true,
      value: {
        host,
        port,
        secure,
        user,
        pass,
        from,
        to,
        subjectPrefix,
        timeoutMs,
        messageTemplate,
      },
    };
  },

  redactConfig(config: EmailChannelConfig) {
    return {
      config: {
        host: config.host,
        port: config.port,
        secure: config.secure ?? null,
        user: config.user ?? null,
        from: config.from,
        to: config.to,
        subjectPrefix: config.subjectPrefix ?? null,
        timeoutMs: config.timeoutMs ?? null,
        hasPass: typeof config.pass === "string" && config.pass.length > 0,
        messageTemplate: config.messageTemplate ?? null,
      },
      meta: {},
    };
  },

  async send(ctx: SendContext, config: EmailChannelConfig): Promise<SendResult> {
    const transport = getOrCreateTransport(config);

    const prefix = config.subjectPrefix ? config.subjectPrefix.trim() : "";
    const subject = `${prefix ? `${prefix} ` : ""}${formatSubjectLine(ctx.message)}`.trim();

    let text: string;
    let html: string;
    if (config.messageTemplate) {
      const vars = buildTemplateVars(ctx.message, ctx.publicBaseUrl);
      text = renderTemplate(config.messageTemplate, vars);
      html = `<div style="font-family:sans-serif;white-space:pre-line">${escHtml(text)}</div>`;
    } else {
      text = formatPlainText(ctx.message);
      html = formatEmailHtml(ctx.message);
    }

    try {
      await transport.sendMail({
        from: config.from,
        to: parseToList(config.to),
        subject,
        text,
        html,
      });
      return { kind: "ok" };
    } catch (e) {
      return { kind: "retryable", error: String(e instanceof Error ? e.message : e) };
    }
  },
};

function parseToList(input: string): string {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(", ");
}
