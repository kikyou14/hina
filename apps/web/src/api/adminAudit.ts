import { fetchJson } from "./http";

export const LOGIN_ATTEMPT_REASONS = ["ok", "no_user", "bad_password"] as const;
export type LoginAttemptReason = (typeof LOGIN_ATTEMPT_REASONS)[number];

export type AdminLoginAuditEntry = {
  tsMs: number;
  success: boolean;
  ip: string | null;
  userAgent: string | null;
  reason: LoginAttemptReason;
  usernameAttempted: string | null;
};

export type AdminLoginAuditResponse = {
  ok: true;
  nowMs: number;
  logs: AdminLoginAuditEntry[];
  hasMore: boolean;
};

export async function getAdminLoginAudit(args: {
  limit: number;
  offset: number;
  onlyFailures?: boolean;
}): Promise<AdminLoginAuditResponse> {
  const qs = new URLSearchParams();
  qs.set("limit", String(args.limit));
  qs.set("offset", String(args.offset));
  if (args.onlyFailures) qs.set("onlyFailures", "1");
  return fetchJson<AdminLoginAuditResponse>(`/api/admin/audit/logins?${qs.toString()}`);
}
