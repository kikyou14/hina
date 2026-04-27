import { readFileSync } from "node:fs";
import { resolve } from "node:path";

declare const __APP_VERSION__: string | undefined;

function getVersion(): string {
  // 1. Compile-time injection (release binaries via bun build --define)
  if (typeof __APP_VERSION__ === "string") return __APP_VERSION__;

  // 2. Runtime: read from root package.json (Docker & dev)
  try {
    const pkgPath = resolve(import.meta.dir, "../../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
}

export const VERSION = getVersion();
