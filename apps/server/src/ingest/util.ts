export { safeJsonStringify } from "../util/lang";

export function clampText(value: string | undefined, maxLen: number): string | null {
  if (!value) return null;
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen);
}

export const PROBE_EXTRA_JSON_MAX_LEN = 32 * 1024;

export const TRACEROUTE_EXTRA_JSON_MAX_BYTES = 48 * 1024;
