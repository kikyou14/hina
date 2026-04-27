import { fetchJson } from "./http";

export type AdminLogEntry = {
  tsMs: number;
  level: "info" | "warn" | "error";
  source?: string;
  msg: string;
};

export async function getAdminLogs(args?: {
  sinceTsMs?: number;
  limit?: number;
}): Promise<{ nowMs: number; entries: AdminLogEntry[] }> {
  const qs = new URLSearchParams();
  if (args?.sinceTsMs !== undefined) qs.set("sinceTsMs", String(args.sinceTsMs));
  if (args?.limit !== undefined) qs.set("limit", String(args.limit));
  const suffix = qs.size ? `?${qs.toString()}` : "";
  return fetchJson<{ nowMs: number; entries: AdminLogEntry[] }>(`/api/admin/logs${suffix}`);
}
