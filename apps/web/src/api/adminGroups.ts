import { fetchJson } from "./http";

export type AdminGroup = { id: string; name: string };

export async function getAdminGroups(): Promise<{ groups: AdminGroup[] }> {
  return fetchJson<{ groups: AdminGroup[] }>("/api/admin/groups");
}
