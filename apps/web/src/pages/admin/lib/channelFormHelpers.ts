import type { AdminAlertChannel, AlertChannelType } from "@/api/adminAlerts";
import { isRecord } from "@/lib/typeGuards";

export type WebhookFields = {
  url: string;
  method: string;
  timeoutMs: string;
  headers: string;
  secret: string;
};

export type TelegramButton = { text: string; url: string };

export type TelegramFields = {
  chatId: string;
  botToken: string;
  disableNotification: boolean;
  threadId: string;
  parseMode: string;
  template: string;
  buttons: TelegramButton[];
};

export type EmailFields = {
  host: string;
  port: string;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
  subjectPrefix: string;
  timeoutMs: string;
};

export type Serverchan3Fields = {
  sendKey: string;
  tags: string;
  short: string;
};

export type ServerchanturboFields = {
  sendKey: string;
  channel: string;
};

export type BarkFields = {
  serverUrl: string;
  deviceKey: string;
  sound: string;
  group: string;
  level: string;
  icon: string;
};

export type ChannelFormField = "webhookHeaders";

export type ChannelFormState = {
  name: string;
  type: AlertChannelType;
  enabled: boolean;
  messageTemplate: string;
  error: string | null;
  errorField: ChannelFormField | null;
  webhook: WebhookFields;
  telegram: TelegramFields;
  email: EmailFields;
  serverchan3: Serverchan3Fields;
  serverchanturbo: ServerchanturboFields;
  bark: BarkFields;
};

export type ChannelFormAction =
  | {
      type: "set";
      patch: Partial<
        Pick<
          ChannelFormState,
          "name" | "type" | "enabled" | "messageTemplate" | "error" | "errorField"
        >
      >;
    }
  | { type: "webhook"; patch: Partial<WebhookFields> }
  | { type: "telegram"; patch: Partial<TelegramFields> }
  | { type: "email"; patch: Partial<EmailFields> }
  | { type: "serverchan3"; patch: Partial<Serverchan3Fields> }
  | { type: "serverchanturbo"; patch: Partial<ServerchanturboFields> }
  | { type: "bark"; patch: Partial<BarkFields> };

export function channelFormReducer(
  state: ChannelFormState,
  action: ChannelFormAction,
): ChannelFormState {
  switch (action.type) {
    case "set":
      return { ...state, ...action.patch };
    case "webhook":
      return { ...state, webhook: { ...state.webhook, ...action.patch } };
    case "telegram":
      return { ...state, telegram: { ...state.telegram, ...action.patch } };
    case "email":
      return { ...state, email: { ...state.email, ...action.patch } };
    case "serverchan3":
      return { ...state, serverchan3: { ...state.serverchan3, ...action.patch } };
    case "serverchanturbo":
      return { ...state, serverchanturbo: { ...state.serverchanturbo, ...action.patch } };
    case "bark":
      return { ...state, bark: { ...state.bark, ...action.patch } };
  }
}

function str(cfg: unknown, key: string, fallback = ""): string {
  if (!isRecord(cfg)) return fallback;
  const v = cfg[key];
  return typeof v === "string" ? v : fallback;
}

function num(cfg: unknown, key: string, fallback: number): number {
  if (!isRecord(cfg)) return fallback;
  const v = cfg[key];
  return typeof v === "number" ? v : fallback;
}

function bool(cfg: unknown, key: string, fallback = false): boolean {
  if (!isRecord(cfg)) return fallback;
  const v = cfg[key];
  return typeof v === "boolean" ? v : fallback;
}

function readButtons(cfg: unknown): TelegramButton[] {
  if (!isRecord(cfg) || !Array.isArray(cfg["buttons"])) return [];
  const raw = cfg["buttons"] as Array<{ text: unknown; url: unknown }>;
  return raw
    .filter((b) => typeof b.text === "string" && typeof b.url === "string")
    .map((b) => ({ text: b.text as string, url: b.url as string }));
}

export function initChannelFormState(channel: AdminAlertChannel | null): ChannelFormState {
  const cfg = channel?.config;
  const threadId = num(cfg, "messageThreadId", 0);
  return {
    name: channel?.name ?? "",
    type: (channel?.type as AlertChannelType) ?? "webhook",
    enabled: channel?.enabled ?? true,
    messageTemplate: str(cfg, "messageTemplate"),
    error: null,
    errorField: null,
    webhook: {
      url: str(cfg, "url"),
      method: str(cfg, "method", "POST"),
      timeoutMs: String(num(cfg, "timeoutMs", 5000)),
      headers:
        isRecord(cfg) && isRecord(cfg["headers"])
          ? JSON.stringify(cfg["headers"], null, 2)
          : JSON.stringify({}, null, 2),
      secret: "",
    },
    telegram: {
      chatId: str(cfg, "chatId"),
      botToken: "",
      disableNotification: bool(cfg, "disableNotification"),
      threadId: threadId > 0 ? String(threadId) : "",
      parseMode: str(cfg, "parseMode", "HTML"),
      template: str(cfg, "messageTemplate"),
      buttons: readButtons(cfg),
    },
    email: {
      host: str(cfg, "host"),
      port: String(num(cfg, "port", 587)),
      secure: bool(cfg, "secure"),
      user: str(cfg, "user"),
      pass: "",
      from: str(cfg, "from"),
      to: str(cfg, "to"),
      subjectPrefix: str(cfg, "subjectPrefix"),
      timeoutMs: String(num(cfg, "timeoutMs", 10_000)),
    },
    serverchan3: {
      sendKey: "",
      tags: str(cfg, "tags"),
      short: str(cfg, "short"),
    },
    serverchanturbo: {
      sendKey: "",
      channel: str(cfg, "channel"),
    },
    bark: {
      serverUrl: str(cfg, "serverUrl", "https://api.day.app"),
      deviceKey: "",
      sound: str(cfg, "sound"),
      group: str(cfg, "group"),
      level: str(cfg, "level"),
      icon: str(cfg, "icon"),
    },
  };
}

export function canSubmitChannel(state: ChannelFormState, mode: "create" | "edit"): boolean {
  if (!state.name.trim()) return false;
  if (mode === "create" && !state.type) return false;
  switch (state.type) {
    case "webhook":
      return !!state.webhook.url.trim();
    case "telegram":
      if (!state.telegram.chatId.trim()) return false;
      if (mode === "create" && !state.telegram.botToken.trim()) return false;
      return true;
    case "email":
      return !!state.email.host.trim() && !!state.email.from.trim() && !!state.email.to.trim();
    case "serverchan3":
      return mode === "edit" || !!state.serverchan3.sendKey.trim();
    case "serverchanturbo":
      return mode === "edit" || !!state.serverchanturbo.sendKey.trim();
    case "bark":
      if (!state.bark.serverUrl.trim()) return false;
      return mode === "edit" || !!state.bark.deviceKey.trim();
    default:
      return true;
  }
}

export type ChannelFormPayload = {
  name: string;
  type?: AlertChannelType;
  enabled: boolean;
  config: Record<string, unknown>;
};

export type BuildChannelResult =
  | { ok: true; payload: ChannelFormPayload }
  | { ok: false; errorKey: string; field: ChannelFormField | null };

export function buildChannelPayload(
  state: ChannelFormState,
  mode: "create" | "edit",
): BuildChannelResult {
  let config: Record<string, unknown> = {};

  switch (state.type) {
    case "webhook": {
      const timeout = Number.parseInt(state.webhook.timeoutMs, 10);
      const headersObj: Record<string, string> = {};
      try {
        const parsed = JSON.parse(state.webhook.headers);
        if (isRecord(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string") headersObj[k] = v;
          }
        }
      } catch {
        return {
          ok: false,
          errorKey: "settings.channelForm.webhook.invalidHeaders",
          field: "webhookHeaders",
        };
      }
      config = {
        url: state.webhook.url.trim(),
        method: state.webhook.method === "PUT" ? "PUT" : "POST",
        timeoutMs: Number.isFinite(timeout) ? timeout : 5000,
        headers: headersObj,
        ...(state.webhook.secret.trim() ? { secret: state.webhook.secret } : {}),
      };
      break;
    }
    case "telegram": {
      const thread = state.telegram.threadId.trim()
        ? Number.parseInt(state.telegram.threadId, 10)
        : undefined;
      const validButtons = state.telegram.buttons.filter((b) => b.text.trim() && b.url.trim());
      config = {
        chatId: state.telegram.chatId.trim(),
        ...(state.telegram.botToken.trim() ? { botToken: state.telegram.botToken.trim() } : {}),
        disableNotification: state.telegram.disableNotification,
        ...(thread && Number.isFinite(thread) ? { messageThreadId: thread } : {}),
        parseMode: state.telegram.parseMode,
        messageTemplate: state.telegram.template.trim() || undefined,
        buttons: validButtons.length > 0 ? validButtons : undefined,
      };
      break;
    }
    case "email": {
      const port = Number.parseInt(state.email.port, 10);
      const timeout = Number.parseInt(state.email.timeoutMs, 10);
      config = {
        host: state.email.host.trim(),
        port: Number.isFinite(port) ? port : 587,
        secure: state.email.secure,
        user: state.email.user.trim() || undefined,
        ...(state.email.pass.trim() ? { pass: state.email.pass } : {}),
        from: state.email.from.trim(),
        to: state.email.to.trim(),
        subjectPrefix: state.email.subjectPrefix.trim() || undefined,
        timeoutMs: Number.isFinite(timeout) ? timeout : 10_000,
      };
      break;
    }
    case "serverchan3":
      config = {
        ...(state.serverchan3.sendKey.trim() ? { sendKey: state.serverchan3.sendKey.trim() } : {}),
        tags: state.serverchan3.tags.trim() || undefined,
        short: state.serverchan3.short.trim() || undefined,
      };
      break;
    case "serverchanturbo":
      config = {
        ...(state.serverchanturbo.sendKey.trim()
          ? { sendKey: state.serverchanturbo.sendKey.trim() }
          : {}),
        channel: state.serverchanturbo.channel.trim() || undefined,
      };
      break;
    case "bark":
      config = {
        serverUrl: state.bark.serverUrl.trim() || "https://api.day.app",
        ...(state.bark.deviceKey.trim() ? { deviceKey: state.bark.deviceKey.trim() } : {}),
        sound: state.bark.sound.trim() || undefined,
        group: state.bark.group.trim() || undefined,
        level: state.bark.level || undefined,
        icon: state.bark.icon.trim() || undefined,
      };
      break;
  }

  if (state.type !== "telegram") {
    config["messageTemplate"] = state.messageTemplate.trim();
  }

  const payload: ChannelFormPayload =
    mode === "create"
      ? { name: state.name.trim(), type: state.type, enabled: state.enabled, config }
      : { name: state.name.trim(), enabled: state.enabled, config };

  return { ok: true, payload };
}
