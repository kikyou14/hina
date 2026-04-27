import type { ValidationError } from "../types";

export function resolveOptStr(
  obj: Record<string, unknown>,
  key: string,
  fallback?: string,
): string | undefined {
  const raw = typeof obj[key] === "string" ? (obj[key] as string) : undefined;
  if (raw !== undefined) return raw || undefined;
  return fallback;
}

export function err(
  field: string,
  code: string,
  message: string,
): { ok: false; error: ValidationError[] } {
  return { ok: false, error: [{ field, code, message }] };
}
