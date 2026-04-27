import path from "node:path";
import { MIGRATIONS_PATH } from "./config";

const SERVER_ROOT = path.resolve(import.meta.dir, "..");

export function resolvePathFromCwd(maybeRelativePath: string): string {
  if (path.isAbsolute(maybeRelativePath)) return maybeRelativePath;
  return path.join(process.cwd(), maybeRelativePath);
}

export function resolvePathFromServerRoot(maybeRelativePath: string): string {
  if (path.isAbsolute(maybeRelativePath)) return maybeRelativePath;
  return path.join(SERVER_ROOT, maybeRelativePath);
}

export function getMigrationsFolder(): string {
  return resolvePathFromServerRoot(MIGRATIONS_PATH);
}
