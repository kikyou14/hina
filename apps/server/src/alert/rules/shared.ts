import type { ValidationError } from "../types";

export function err(
  field: string,
  code: string,
  message: string,
): { ok: false; error: ValidationError[] } {
  return { ok: false, error: [{ field, code, message }] };
}

export function parseStringArr(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}
