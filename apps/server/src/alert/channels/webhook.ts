import { createHmac } from "node:crypto";
import { isRecord } from "../../util/lang";
import { classifyFetchPublicFailure, fetchPublicHttpTarget, isPublicHttpUrl } from "../../util/url";
import type { TemplateVars } from "../message/template";
import { renderTemplate } from "../message/template";
import { buildTemplateVars } from "../message/vars";
import type { Result, ValidationError } from "../types";
import { err, resolveOptStr } from "./shared";
import type { Notifier, SendContext, SendResult } from "./types";
import { withTimeout } from "./types";

export type WebhookChannelConfig = {
  url: string;
  method?: "POST" | "PUT";
  timeoutMs?: number;
  headers?: Record<string, string>;
  secret?: string;
  messageTemplate?: string;
};

export const webhookNotifier: Notifier<WebhookChannelConfig> = {
  type: "webhook",

  parseConfig(
    raw: unknown,
    existing?: WebhookChannelConfig,
  ): Result<WebhookChannelConfig, ValidationError[]> {
    if (!isRecord(raw)) raw = {};
    const obj = raw as Record<string, unknown>;

    const url = typeof obj["url"] === "string" ? obj["url"].trim() : (existing?.url ?? "");
    if (!url) return err("config.url", "missing_url", "url is required");
    if (!isPublicHttpUrl(url)) {
      return err(
        "config.url",
        "invalid_url",
        "url must be a public http(s) URL (private IPs and localhost are not allowed)",
      );
    }

    const methodRaw =
      typeof obj["method"] === "string"
        ? obj["method"].trim().toUpperCase()
        : (existing?.method ?? "POST");
    const method: "POST" | "PUT" = methodRaw === "PUT" ? "PUT" : "POST";

    const timeoutMsRaw =
      typeof obj["timeoutMs"] === "number" ? obj["timeoutMs"] : (existing?.timeoutMs ?? 5000);
    const timeoutMs =
      Number.isFinite(timeoutMsRaw) && Number.isInteger(timeoutMsRaw)
        ? Math.min(Math.max(timeoutMsRaw, 500), 60_000)
        : 5000;

    const headers = obj["headers"] !== undefined ? parseHeaders(obj["headers"]) : existing?.headers;
    const secretRaw = typeof obj["secret"] === "string" ? obj["secret"] : undefined;
    const secret = secretRaw !== undefined ? secretRaw : existing?.secret;
    const messageTemplate = resolveOptStr(obj, "messageTemplate", existing?.messageTemplate);

    return { ok: true, value: { url, method, timeoutMs, headers, secret, messageTemplate } };
  },

  redactConfig(config: WebhookChannelConfig) {
    const headers = config.headers ? Object.keys(config.headers) : [];
    return {
      config: {
        url: config.url,
        method: config.method ?? null,
        timeoutMs: config.timeoutMs ?? null,
        headers,
        hasSecret: typeof config.secret === "string" && config.secret.length > 0,
        messageTemplate: config.messageTemplate ?? null,
      },
      meta: {},
    };
  },

  async send(ctx: SendContext, config: WebhookChannelConfig): Promise<SendResult> {
    const vars: TemplateVars | undefined = config.messageTemplate
      ? buildTemplateVars(ctx.message, ctx.publicBaseUrl)
      : undefined;
    const payload = vars
      ? { ...ctx.message, text: renderTemplate(config.messageTemplate!, vars) }
      : ctx.message;
    const body = JSON.stringify(payload);

    const headers = new Headers();
    headers.set("content-type", "application/json");
    if (config.headers) {
      for (const [k, v] of Object.entries(config.headers)) headers.set(k, v);
    }
    if (config.secret) {
      const sig = createHmac("sha256", config.secret).update(body).digest("hex");
      headers.set("x-hina-signature", `sha256=${sig}`);
    }

    const { signal, cancel } = withTimeout(config.timeoutMs ?? 5000);
    try {
      const result = await fetchPublicHttpTarget(config.url, {
        method: config.method ?? "POST",
        headers,
        body,
        signal,
        bodyBoundHeaders: ["x-hina-signature"],
      });
      if (!result.ok) {
        return {
          kind: classifyFetchPublicFailure(result.reason),
          error: `webhook url rejected: ${result.reason}`,
        };
      }
      const resp = result.response;
      if (!resp.ok) return { kind: "retryable", error: `webhook non-2xx: ${resp.status}` };
      return { kind: "ok" };
    } catch (e) {
      return { kind: "retryable", error: String(e instanceof Error ? e.message : e) };
    } finally {
      cancel();
    }
  },
};

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k === "string" && typeof v === "string") {
      const key = k.trim();
      if (key) out[key] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
