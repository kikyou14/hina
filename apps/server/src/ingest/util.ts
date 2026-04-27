export { safeJsonStringify } from "../util/lang";

export function clampText(value: string | undefined, maxLen: number): string | null {
  if (!value) return null;
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen);
}
