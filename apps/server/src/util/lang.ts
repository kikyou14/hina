export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeJsonParse(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function safeJsonStringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

export function escapeLike(input: string): string {
  return input.replace(/[%_!]/g, "!$&");
}

export function clampText(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen);
}
