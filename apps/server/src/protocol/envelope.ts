import { decode, encode } from "@msgpack/msgpack";
import { isRecord } from "../util/lang";

export const PROTOCOL_VERSION = 1 as const;

export enum MessageType {
  Hello = 1,
  Welcome = 2,
  Telemetry = 3,
  ProbeConfig = 4,
  ProbeResult = 5,
  IpUpdate = 6,
  Error = 9,
}

export type Envelope<TBody = unknown> = {
  v: number;
  t: number;
  i: number;
  s: number;
  b: TBody;
};

export type HelloBody = {
  tok: string;
  aid?: string;
  ver?: string;
  host?: string;
  os?: string;
  arch?: string;
  inv?: unknown;
  cap?: unknown;
  x?: unknown;
  ip4?: string;
  ip6?: string;
};

export type WelcomeBody = {
  aid: string;
  stm: number;
  cfg: {
    t_ms: number;
    j_ms: number;
  };
};

export type TelemetryBody = {
  aid?: string;
  seq: number;
  up_s?: number;
  rx: number;
  tx: number;
  m: Record<string, unknown>;
  x?: unknown;
};

export type ProbeTaskKind = "icmp" | "tcp" | "http" | "traceroute";

export type ProbeTaskWire = {
  id: string;
  k: ProbeTaskKind;
  int_s: number;
  to_ms: number;
  tar: unknown;
  en?: boolean;
  name?: string;
  x?: unknown;
};

export type ProbeConfigBody = {
  rev: number;
  tasks: ProbeTaskWire[];
};

export type ProbeResultBody = {
  tid: string;
  ts: number;
  ok: boolean;
  lat_ms?: number;
  code?: number;
  err?: string;
  x?: unknown;
  loss?: number;
  jit_ms?: number;
};

export type IpUpdateBody = {
  ip4?: string;
  ip6?: string;
};

export type ErrorBody = {
  code: string;
  message: string;
};

export function decodeEnvelope(bytes: Uint8Array): Envelope | null {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return null;
  }

  if (!isRecord(decoded)) return null;
  const v = decoded["v"];
  const t = decoded["t"];
  const i = decoded["i"];
  const s = decoded["s"];
  const b = decoded["b"];

  if (
    typeof v !== "number" ||
    typeof t !== "number" ||
    typeof i !== "number" ||
    typeof s !== "number"
  )
    return null;
  if (!Number.isFinite(v) || !Number.isFinite(t) || !Number.isFinite(i) || !Number.isFinite(s))
    return null;

  return { v, t, i, s, b };
}

export function encodeEnvelope<TBody>(t: MessageType, body: TBody): Uint8Array {
  const envelope: Envelope<TBody> = {
    v: PROTOCOL_VERSION,
    t,
    i: Math.floor(Math.random() * 2 ** 31),
    s: Date.now(),
    b: body,
  };
  return encode(envelope);
}

export function parseHelloBody(body: unknown): HelloBody | null {
  if (!isRecord(body)) return null;
  const tok = body["tok"];
  if (typeof tok !== "string" || tok.length === 0) return null;
  const aid = typeof body["aid"] === "string" ? body["aid"] : undefined;
  const ver = typeof body["ver"] === "string" ? body["ver"] : undefined;
  const host = typeof body["host"] === "string" ? body["host"] : undefined;
  const os = typeof body["os"] === "string" ? body["os"] : undefined;
  const arch = typeof body["arch"] === "string" ? body["arch"] : undefined;
  const inv = body["inv"];
  const cap = body["cap"];
  const x = body["x"];
  const ip4 = typeof body["ip4"] === "string" ? body["ip4"] : undefined;
  const ip6 = typeof body["ip6"] === "string" ? body["ip6"] : undefined;
  return { tok, aid, ver, host, os, arch, inv, cap, x, ip4, ip6 };
}

export function parseTelemetryBody(body: unknown): TelemetryBody | null {
  if (!isRecord(body)) return null;

  const seq = body["seq"];
  const rx = body["rx"];
  const tx = body["tx"];
  const m = body["m"];

  if (typeof seq !== "number" || !Number.isFinite(seq) || seq < 0) return null;
  if (typeof rx !== "number" || !Number.isFinite(rx) || rx < 0) return null;
  if (typeof tx !== "number" || !Number.isFinite(tx) || tx < 0) return null;
  if (!isRecord(m)) return null;

  const aid = typeof body["aid"] === "string" ? body["aid"] : undefined;
  const upS =
    typeof body["up_s"] === "number" && Number.isFinite(body["up_s"])
      ? (body["up_s"] as number)
      : undefined;
  return { aid, seq, up_s: upS, rx, tx, m };
}

const PROBE_TS_FUTURE_TOLERANCE_MS = 60 * 1000;

export function parseProbeResultBody(body: unknown, recvTsMs: number): ProbeResultBody | null {
  if (!isRecord(body)) return null;

  const tid = body["tid"];
  const ts = body["ts"];
  const ok = body["ok"];

  if (typeof tid !== "string" || tid.length === 0) return null;
  if (typeof ts !== "number" || !Number.isFinite(ts) || !Number.isSafeInteger(ts) || ts <= 0)
    return null;
  if (ts > recvTsMs + PROBE_TS_FUTURE_TOLERANCE_MS) return null;
  if (typeof ok !== "boolean") return null;

  const latRaw = body["lat_ms"];
  const codeRaw = body["code"];
  const errRaw = body["err"];
  const x = body["x"];
  const lossRaw = body["loss"];
  const jitRaw = body["jit_ms"];

  const latMs =
    typeof latRaw === "number" &&
    Number.isFinite(latRaw) &&
    Number.isSafeInteger(latRaw) &&
    latRaw >= 0
      ? latRaw
      : undefined;
  const code =
    typeof codeRaw === "number" &&
    Number.isFinite(codeRaw) &&
    Number.isSafeInteger(codeRaw) &&
    codeRaw >= 0
      ? codeRaw
      : undefined;
  const err = typeof errRaw === "string" ? errRaw : undefined;
  const loss =
    typeof lossRaw === "number" && Number.isFinite(lossRaw) && lossRaw >= 0 && lossRaw <= 100
      ? lossRaw
      : undefined;
  const jitMs =
    typeof jitRaw === "number" && Number.isFinite(jitRaw) && jitRaw >= 0 ? jitRaw : undefined;

  return { tid, ts, ok, lat_ms: latMs, code, err, x, loss, jit_ms: jitMs };
}

export function parseIpUpdateBody(body: unknown): IpUpdateBody | null {
  if (!isRecord(body)) return null;
  const ip4 = typeof body["ip4"] === "string" ? body["ip4"] : undefined;
  const ip6 = typeof body["ip6"] === "string" ? body["ip6"] : undefined;
  if (ip4 === undefined && ip6 === undefined) return null;
  return { ip4, ip6 };
}

export function encodeError(code: string, message: string): Uint8Array {
  return encodeEnvelope<ErrorBody>(MessageType.Error, { code, message });
}
