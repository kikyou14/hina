import { isIP } from "node:net";
import { isRecord } from "../../util/lang";

export { escapeLike, isRecord, safeJsonParse, uniqueStrings } from "../../util/lang";

const HOSTNAME_RE = /^(?!-)([a-zA-Z0-9-]{1,63}(?<!-)\.)*[a-zA-Z]{2,63}$/;

function isValidHost(value: string): boolean {
  if (!value) return false;
  if (isIP(value) !== 0) return true;
  return HOSTNAME_RE.test(value);
}

function isIpv6(value: string): boolean {
  return isIP(value) === 6;
}

export const MAX_NAME_LEN = 200;
export const MAX_NOTE_LEN = 2000;
export const MAX_TAG_LEN = 64;
export const MAX_TAGS_COUNT = 32;

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;

export type PageQuery = { limit: number; offset: number };

export function parsePageQuery(
  q: { limit?: string; offset?: string },
  defaultLimit: number = DEFAULT_PAGE_SIZE,
): PageQuery {
  const rawLimit = parsePositiveIntQuery(q.limit);
  const limit = Math.min(rawLimit ?? defaultLimit, MAX_PAGE_SIZE);
  const offset = parseNonNegativeIntQuery(q.offset) ?? 0;
  return { limit, offset };
}

export function parseStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    out.push(s);
  }
  return out;
}

export function parseAgentTags(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length > MAX_TAGS_COUNT) return null;
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") return null;
    const s = item.trim();
    if (!s) continue;
    if (s.length > MAX_TAG_LEN) return null;
    out.push(s);
  }
  return out;
}

export function parseBoolQuery(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return null;
}

export function parsePositiveIntQuery(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function parseNonNegativeIntQuery(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

export function parseCsvQuery(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export type ProbeKind = "icmp" | "tcp" | "http" | "traceroute";

export function parseProbeKind(value: unknown): ProbeKind | null {
  if (value === "icmp" || value === "tcp" || value === "http" || value === "traceroute")
    return value;
  return null;
}

export function parseIntervalSec(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value < 1 || value > 86400) return null;
  return value;
}

export function parseTimeoutMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value < 100 || value > 120_000) return null;
  return value;
}

export function parseTarget(
  kind: ProbeKind,
  value: unknown,
): { target: unknown; targetJson: string } | null {
  if (!isRecord(value)) return null;

  if (kind === "icmp") {
    const host = typeof value["host"] === "string" ? value["host"].trim() : "";
    if (!host || !isValidHost(host)) return null;
    const target = { host };
    return { target, targetJson: JSON.stringify(target) };
  }

  if (kind === "traceroute") {
    const host = typeof value["host"] === "string" ? value["host"].trim() : "";
    if (!host || !isValidHost(host)) return null;
    if (isIpv6(host)) return null;
    const target = { host };
    return { target, targetJson: JSON.stringify(target) };
  }

  if (kind === "tcp") {
    const host = typeof value["host"] === "string" ? value["host"].trim() : "";
    const port = typeof value["port"] === "number" ? value["port"] : Number.NaN;
    if (!host || !isValidHost(host)) return null;
    if (!Number.isFinite(port) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    const target = { host, port };
    return { target, targetJson: JSON.stringify(target) };
  }

  const url = typeof value["url"] === "string" ? value["url"].trim() : "";
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  } catch {
    return null;
  }
  const target = { url };
  return { target, targetJson: JSON.stringify(target) };
}
