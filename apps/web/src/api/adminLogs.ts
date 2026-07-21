import { fetchJson } from "./http";

export type AdminLogEntry = {
  id: string;
  tsMs: number;
  level: "info" | "warn" | "error";
  source?: string;
  msg: string;
};

export type AdminLogsResponse = {
  nowMs: number;
  entries: AdminLogEntry[];
  nextCursor: string;
  hasMore: boolean;
  reset: boolean;
};

export async function getAdminLogs(args?: {
  after?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<AdminLogsResponse> {
  const qs = new URLSearchParams();
  if (args?.after !== undefined) qs.set("after", args.after);
  if (args?.limit !== undefined) qs.set("limit", String(args.limit));
  const suffix = qs.size ? `?${qs.toString()}` : "";
  return fetchJson<AdminLogsResponse>(`/api/admin/logs${suffix}`, { signal: args?.signal });
}
