import { fetchJson } from "./http";

export type AdminRuntimeAgentConfig = {
  telemetryIntervalMs: number;
  telemetryJitterMs: number;
};

export type AdminRuntimeAgentConfigSource = {
  telemetryIntervalMs: "default" | "db";
  telemetryJitterMs: "default" | "db";
};

export type AdminRuntimeConfigResponse = {
  current: AdminRuntimeAgentConfig;
  defaults: AdminRuntimeAgentConfig;
  source: AdminRuntimeAgentConfigSource;
};

export async function getAdminRuntimeConfig(): Promise<AdminRuntimeConfigResponse> {
  return fetchJson<AdminRuntimeConfigResponse>("/api/admin/system/runtime-config");
}

export async function patchAdminRuntimeConfig(
  patch: Partial<AdminRuntimeAgentConfig>,
): Promise<AdminRuntimeConfigResponse & { ok: true; pushed: number }> {
  return fetchJson<AdminRuntimeConfigResponse & { ok: true; pushed: number }>(
    "/api/admin/system/runtime-config",
    {
      method: "PATCH",
      body: JSON.stringify(patch),
    },
  );
}

export type AsnDbStatus = {
  loaded: boolean;
  fileAgeMs: number | null;
  refreshing: boolean;
};

export async function getAsnDbStatus(): Promise<AsnDbStatus> {
  return fetchJson<AsnDbStatus>("/api/admin/system/asn-db");
}

export async function refreshAsnDb(): Promise<{ ok: boolean; error?: string }> {
  return fetchJson<{ ok: boolean; error?: string }>("/api/admin/system/asn-db/refresh", {
    method: "POST",
  });
}

// ── SQLite database ──

export type DbStatus = {
  dbSizeBytes: number;
  walSizeBytes: number;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
};

export async function getDbStatus(): Promise<DbStatus> {
  return fetchJson<DbStatus>("/api/admin/system/db");
}

export async function vacuumDb(): Promise<{ ok: boolean; error?: string }> {
  return fetchJson<{ ok: boolean; error?: string }>("/api/admin/system/db/vacuum", {
    method: "POST",
  });
}

export async function optimizeDb(): Promise<{ ok: boolean; error?: string }> {
  return fetchJson<{ ok: boolean; error?: string }>("/api/admin/system/db/optimize", {
    method: "POST",
  });
}

export type DbBackupResponse = {
  ok: true;
  token: string;
  filename: string;
  sizeBytes: number;
};

export async function createDbBackup(): Promise<DbBackupResponse> {
  return fetchJson<DbBackupResponse>("/api/admin/system/db/backup", {
    method: "POST",
  });
}

export function startBackupDownload(token: string): void {
  window.location.href = `/api/admin/system/db/backup/download?token=${encodeURIComponent(token)}`;
}
