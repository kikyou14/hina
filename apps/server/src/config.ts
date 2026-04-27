import { type Cidr, parseTrustedProxyExtras } from "./util/trust-proxy";

export type ServerConfig = {
  port: number;
  dbPath: string;
  trustedProxyExtras: readonly Cidr[];
};

export const WS_HELLO_TIMEOUT_MS = 15_000;
export const MAX_WS_PAYLOAD_BYTES = 64 * 1024;
export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WEB_DIST_PATH = process.env.HINA_WEB_DIST_PATH ?? "../web/dist";
export const MIGRATIONS_PATH = process.env.HINA_MIGRATIONS_PATH ?? "./drizzle";
export const GEO_DATA_DIR = process.env.HINA_GEO_DIR ?? ".cache/geo";

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parseInt(env.PORT ?? "3000", 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error("Invalid PORT");
  }

  const dbPath = env.HINA_DB_PATH ?? "data/hina.sqlite";
  const trustedProxyExtras = parseTrustedProxyExtras(env.HINA_TRUSTED_PROXIES);

  return {
    port,
    dbPath,
    trustedProxyExtras,
  };
}
