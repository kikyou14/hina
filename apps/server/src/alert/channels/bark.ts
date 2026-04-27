import { isRecord } from "../../util/lang";
import { classifyFetchPublicFailure, fetchHttpTarget, parseHttpUrl } from "../../util/url";
import { formatPlainText, formatSubjectLine } from "../message/format-plain";
import { renderTemplate } from "../message/template";
import { buildTemplateVars } from "../message/vars";
import type { Result, ValidationError } from "../types";
import { err, resolveOptStr } from "./shared";
import type { Notifier, SendContext, SendResult } from "./types";
import { withTimeout } from "./types";

export type BarkLevel = "critical" | "timeSensitive" | "active" | "passive";

export type BarkChannelConfig = {
  serverUrl: string;
  deviceKey: string;
  sound?: string;
  group?: string;
  level?: BarkLevel;
  icon?: string;
  messageTemplate?: string;
};

const BARK_LEVELS = new Set<string>(["critical", "timeSensitive", "active", "passive"]);

export const barkNotifier: Notifier<BarkChannelConfig> = {
  type: "bark",

  parseConfig(
    raw: unknown,
    existing?: BarkChannelConfig,
  ): Result<BarkChannelConfig, ValidationError[]> {
    if (!isRecord(raw)) raw = {};
    const obj = raw as Record<string, unknown>;

    const serverUrlRaw = typeof obj["serverUrl"] === "string" ? obj["serverUrl"].trim() : "";
    const serverUrl = serverUrlRaw || existing?.serverUrl || "https://api.day.app";
    if (!parseHttpUrl(serverUrl)) {
      return err("config.serverUrl", "invalid_server_url", "serverUrl must be an http(s) URL");
    }

    const deviceKeyRaw = typeof obj["deviceKey"] === "string" ? obj["deviceKey"].trim() : "";
    const deviceKey = deviceKeyRaw || existing?.deviceKey || "";
    if (!deviceKey) return err("config.deviceKey", "missing_device_key", "deviceKey is required");

    const sound = resolveOptStr(obj, "sound", existing?.sound);
    const group = resolveOptStr(obj, "group", existing?.group);
    const icon = resolveOptStr(obj, "icon", existing?.icon);
    const messageTemplate = resolveOptStr(obj, "messageTemplate", existing?.messageTemplate);

    const levelRaw = typeof obj["level"] === "string" ? obj["level"] : undefined;
    const level: BarkLevel | undefined =
      levelRaw !== undefined
        ? BARK_LEVELS.has(levelRaw)
          ? (levelRaw as BarkLevel)
          : undefined
        : existing?.level;

    return {
      ok: true,
      value: {
        serverUrl: serverUrl.replace(/\/+$/, ""),
        deviceKey,
        sound: sound || undefined,
        group: group || undefined,
        level,
        icon: icon || undefined,
        messageTemplate,
      },
    };
  },

  redactConfig(config: BarkChannelConfig) {
    return {
      config: {
        serverUrl: config.serverUrl,
        hasDeviceKey: typeof config.deviceKey === "string" && config.deviceKey.length > 0,
        sound: config.sound ?? null,
        group: config.group ?? null,
        level: config.level ?? null,
        icon: config.icon ?? null,
        messageTemplate: config.messageTemplate ?? null,
      },
      meta: {},
    };
  },

  async send(ctx: SendContext, config: BarkChannelConfig): Promise<SendResult> {
    const base = ctx.publicBaseUrl?.replace(/\/+$/, "") ?? "";
    const dashboardUrl = base ? `${base}/agents/${ctx.message.subject.agent.id}` : "";

    const bodyText = config.messageTemplate
      ? renderTemplate(config.messageTemplate, buildTemplateVars(ctx.message, ctx.publicBaseUrl))
      : formatPlainText(ctx.message);

    const body: Record<string, unknown> = {
      device_key: config.deviceKey,
      title: formatSubjectLine(ctx.message),
      body: bodyText,
      level: config.level ?? severityToBarkLevel(ctx.message.severity),
    };
    if (config.sound) body["sound"] = config.sound;
    if (config.group) body["group"] = config.group;
    if (config.icon) body["icon"] = config.icon;
    if (dashboardUrl) body["url"] = dashboardUrl;

    const { signal, cancel } = withTimeout(10_000);
    try {
      const result = await fetchHttpTarget(`${config.serverUrl}/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!result.ok) {
        return {
          kind: classifyFetchPublicFailure(result.reason),
          error: `bark url rejected: ${result.reason}`,
        };
      }
      const resp = result.response;
      if (!resp.ok) {
        const respText = await resp.text().catch(() => "");
        return { kind: "retryable", error: `bark non-2xx: ${resp.status} ${respText}`.trim() };
      }
      return { kind: "ok" };
    } catch (e) {
      return { kind: "retryable", error: String(e instanceof Error ? e.message : e) };
    } finally {
      cancel();
    }
  },
};

function severityToBarkLevel(severity: string): string {
  if (severity === "critical") return "critical";
  if (severity === "warning") return "timeSensitive";
  return "active";
}
