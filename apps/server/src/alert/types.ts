export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type ValidationError = {
  field?: string;
  code: string;
  message: string;
};

export type AlertSeverity = "info" | "warning" | "critical";

export type AlertChannelType =
  | "webhook"
  | "telegram"
  | "email"
  | "serverchan3"
  | "serverchanturbo"
  | "bark";

export type AlertNotificationStatus = "pending" | "sent" | "dead";

export type AlertRuleKind =
  | "agent_offline"
  | "metric_threshold"
  | "probe_failed"
  | "probe_latency"
  | "quota_exceeded"
  | "agent_expiring"
  | "route_change";

export type AlertNotificationKind = "firing" | "recovered";

export type AlertMessageV1 = {
  v: 1;
  kind: AlertNotificationKind;
  severity: AlertSeverity;
  rule: { id: string; name: string; kind: AlertRuleKind };
  subject: {
    key: string;
    agent: { id: string; name: string; group: string | null };
    task?: { id: string; name: string | null };
  };
  value: unknown;
  tsMs: number;
};
