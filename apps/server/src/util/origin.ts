import { resolveForwardedProto } from "./trust-proxy";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!HTTP_PROTOCOLS.has(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  return parsed.origin;
}

function firstHeader(value: string | null): string | null {
  if (!value) return null;
  const [first] = value.split(",");
  const trimmed = first?.trim();
  return trimmed ? trimmed : null;
}

function requestProtocol(
  req: Request,
  peerIp: string | null | undefined,
): "http:" | "https:" | null {
  const forwarded = resolveForwardedProto(req, peerIp);
  if (forwarded) return `${forwarded}:` as const;
  try {
    const proto = new URL(req.url).protocol;
    if (proto === "http:" || proto === "https:") return proto;
  } catch {
    // fall through
  }
  return null;
}

export function getExpectedOrigins(req: Request, peerIp?: string | null): string[] {
  const proto = requestProtocol(req, peerIp);
  if (!proto) return [];
  const host = firstHeader(req.headers.get("host"));
  if (!host) return [];
  const normalized = normalizeOrigin(`${proto}//${host}`);
  return normalized ? [normalized] : [];
}

export type OriginCheck =
  | { ok: true; origin: string }
  | {
      ok: false;
      reason: "missing" | "invalid" | "forbidden";
      origin: string | null;
      hint?: string;
    };

function proxyHostHint(req: Request): string | undefined {
  const host = firstHeader(req.headers.get("host"));
  const forwardedHost = firstHeader(req.headers.get("x-forwarded-host"));
  if (!host || !forwardedHost) return undefined;
  if (forwardedHost.toLowerCase() === host.toLowerCase()) return undefined;
  return (
    `X-Forwarded-Host (${forwardedHost}) differs from Host (${host}); ` +
    `the reverse proxy is likely missing 'proxy_set_header Host $host;' ` +
    `(nginx) or an equivalent Host pass-through. Hina derives the expected ` +
    `origin from Host only — X-Forwarded-Host is intentionally ignored.`
  );
}

export function checkRequestOrigin(req: Request, opts?: { peerIp?: string | null }): OriginCheck {
  const rawOrigin = req.headers.get("origin");
  if (!rawOrigin) return { ok: false, reason: "missing", origin: null };
  const origin = normalizeOrigin(rawOrigin);
  if (!origin) return { ok: false, reason: "invalid", origin: rawOrigin };

  const expected = getExpectedOrigins(req, opts?.peerIp);
  if (expected.includes(origin)) return { ok: true, origin };

  const hint = proxyHostHint(req);
  return hint
    ? { ok: false, reason: "forbidden", origin, hint }
    : { ok: false, reason: "forbidden", origin };
}
