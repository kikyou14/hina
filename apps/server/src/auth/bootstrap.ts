import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client";
import { user as userTable } from "../db/schema";
import { randomBase64Url } from "../util/random";
import { hashPassword } from "./password";

export type BootstrapResult =
  | { created: true; username: string; credentialFile: string }
  | { created: false; username: string };

const CREDENTIAL_FILENAME = "admin-credentials.txt";

/**
 * Resolve the path for the credential file.
 * Written next to the database file so it lives on the same persistent volume.
 */
function credentialFilePath(dbPath: string): string {
  return path.join(path.dirname(dbPath), CREDENTIAL_FILENAME);
}

export async function ensureAdminUser(
  db: DbClient,
  opts: { dbPath: string },
): Promise<BootstrapResult> {
  const existing = await db
    .select({ id: userTable.id, username: userTable.username })
    .from(userTable)
    .where(eq(userTable.role, "admin"))
    .limit(2);

  if (existing.length > 0) return { created: false, username: existing[0]!.username };

  const envPassword = process.env.HINA_ADMIN_PASSWORD;
  const password = envPassword && envPassword.length > 0 ? envPassword : randomBase64Url(24);
  const passwordHash = await hashPassword(password);
  const nowMs = Date.now();

  await db.insert(userTable).values({
    id: crypto.randomUUID(),
    username: "admin",
    passwordHash,
    role: "admin",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });

  // When the password was supplied via env var the user already knows it —
  // skip writing a credential file.
  if (envPassword) {
    return { created: true, username: "admin", credentialFile: "" };
  }

  const filePath = credentialFilePath(opts.dbPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `username=admin\npassword=${password}\n`, { mode: 0o600 });
  return { created: true, username: "admin", credentialFile: filePath };
}

/**
 * Remove the credential file if it exists.
 * Called after password reset to avoid leaving a stale file on disk.
 */
export function removeCredentialFile(dbPath: string): void {
  try {
    fs.unlinkSync(credentialFilePath(dbPath));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`Failed to remove credential file: ${err}`);
    }
  }
}
