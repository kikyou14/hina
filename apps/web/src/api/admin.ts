import { fetchJson, isUnauthorizedError } from "./http";

export type AdminUser = {
  id: string;
  username: string;
  role: string;
};

export type AdminLoginResponse = {
  ok: true;
  user: AdminUser;
  expiresAtMs: number;
  token?: string;
};

export type AdminMeResponse = {
  ok: true;
  user: AdminUser | null;
};

export async function adminLogin(args: {
  username: string;
  password: string;
}): Promise<AdminLoginResponse> {
  return fetchJson<AdminLoginResponse>("/api/admin/session/login", {
    method: "POST",
    body: JSON.stringify({ username: args.username, password: args.password }),
  });
}

export async function adminLogout(): Promise<{ ok: true }> {
  return fetchJson<{ ok: true }>("/api/admin/session/logout", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function adminMe(): Promise<AdminMeResponse> {
  return fetchJson<AdminMeResponse>("/api/admin/session/me");
}

export async function adminMeOptional(): Promise<AdminMeResponse> {
  try {
    return await adminMe();
  } catch (err) {
    if (isUnauthorizedError(err)) return { ok: true, user: null };
    throw err;
  }
}
