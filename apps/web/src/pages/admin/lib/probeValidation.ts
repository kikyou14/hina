import type { ProbeKind, ProbeTaskTarget } from "@/api/adminProbes";

export const SELECT_ALL_VALUE = "__all__";

const HOSTNAME_RE = /^(?!-)([a-zA-Z0-9-]{1,63}(?<!-)\.)*[a-zA-Z]{2,63}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv6Literal(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return unwrapped.includes(":") && !unwrapped.includes("/");
}

export function isValidHost(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (s.includes(":")) return true;
  const m = IPV4_RE.exec(s);
  if (m) return m.slice(1).every((p) => Number(p) <= 255);
  return HOSTNAME_RE.test(s);
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export type ProbeTaskFormValue = {
  name: string;
  kind: ProbeKind;
  target: ProbeTaskTarget;
  intervalSec: number;
  timeoutMs: number;
  enabled: boolean;
  allAgents: boolean;
  traceRevealHopDetails: boolean;
  groupIds: string[];
  agentIds: string[];
};
