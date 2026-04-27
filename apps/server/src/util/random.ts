import { randomBytes } from "node:crypto";

export function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomAgentToken(bytes: number): string {
  return `agt_${randomBytes(bytes).toString("base64url")}`;
}
