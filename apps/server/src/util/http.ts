import { resolveForwardedProto } from "./trust-proxy";

export function isSecureRequest(req: Request, peerIp?: string | null): boolean {
  if (resolveForwardedProto(req, peerIp) === "https") return true;
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}
