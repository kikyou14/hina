import { fetchJson } from "./http";

export async function patchAdminUsername(args: {
  username: string;
  currentPassword: string;
}): Promise<{ ok: true; username: string }> {
  return fetchJson<{ ok: true; username: string }>("/api/admin/account/username", {
    method: "PATCH",
    body: JSON.stringify(args),
  });
}

export async function patchAdminPassword(args: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>("/api/admin/account/password", {
    method: "PATCH",
    body: JSON.stringify(args),
  });
}
