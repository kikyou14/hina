import { eq } from "drizzle-orm";
import { ensureAdminUser, removeCredentialFile } from "./src/auth/bootstrap";
import { hashPassword } from "./src/auth/password";
import { revokeUserSessions } from "./src/auth/session";
import { createDbClient } from "./src/db/client";
import {
  agent as agentTable,
  agentBilling as agentBillingTable,
  agentGroup as agentGroupTable,
  agentStatus as agentStatusTable,
  user as userTable,
} from "./src/db/schema";
import { getMigrationsFolder, resolvePathFromCwd } from "./src/paths";
import { sha256Hex } from "./src/util/hash";
import { randomAgentToken, randomBase64Url } from "./src/util/random";

type ParsedCommand =
  | { command: "reset-password"; username?: string; password?: string }
  | {
      command: "create-agent";
      name: string;
      groupName?: string;
      token?: string;
      isPublic: boolean;
    };

function parseCommand(argv: string[]): ParsedCommand {
  const [, , commandRaw, ...rest] = argv;
  if (commandRaw !== "reset-password" && commandRaw !== "create-agent") {
    throw new Error(`Unknown command: ${commandRaw ?? ""}`);
  }

  if (commandRaw === "reset-password") {
    let username: string | undefined;
    let password: string | undefined;

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "--username") {
        username = rest[++i] ?? "";
        continue;
      }
      if (arg === "--password") {
        password = rest[++i] ?? "";
        continue;
      }
      throw new Error(`Unknown arg: ${arg}`);
    }

    if (username !== undefined && username.length === 0)
      throw new Error("Missing --username value");
    if (password !== undefined && password.length === 0)
      throw new Error("Missing --password value");

    return { command: "reset-password", username, password };
  }

  let name = "";
  let groupName: string | undefined;
  let token: string | undefined;
  let isPublic = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--name") {
      name = rest[++i] ?? "";
      continue;
    }
    if (arg === "--group") {
      groupName = rest[++i] ?? "";
      continue;
    }
    if (arg === "--token") {
      token = rest[++i] ?? "";
      continue;
    }
    if (arg === "--public") {
      isPublic = true;
      continue;
    }
    throw new Error(`Unknown arg: ${arg}`);
  }

  if (!name) throw new Error("Missing --name value");
  if (groupName !== undefined && groupName.length === 0) throw new Error("Missing --group value");
  if (token !== undefined && token.length === 0) throw new Error("Missing --token value");

  return { command: "create-agent", name, groupName, token, isPublic };
}

async function main() {
  const parsed = parseCommand(process.argv);

  const dbPath = resolvePathFromCwd(process.env.HINA_DB_PATH ?? "data/hina.sqlite");
  const db = await createDbClient({
    dbPath,
    migrationsFolder: getMigrationsFolder(),
  });

  await ensureAdminUser(db, { dbPath });

  const nowMs = Date.now();

  if (parsed.command === "reset-password") {
    const password = parsed.password ?? randomBase64Url(24);
    const passwordHash = await hashPassword(password);

    const targetUsers = parsed.username
      ? await db
          .select({ id: userTable.id, username: userTable.username })
          .from(userTable)
          .where(eq(userTable.username, parsed.username))
          .limit(1)
      : await db
          .select({ id: userTable.id, username: userTable.username })
          .from(userTable)
          .where(eq(userTable.role, "admin"))
          .limit(2);

    if (targetUsers.length === 0)
      throw new Error(
        parsed.username ? `User not found: ${parsed.username}` : "Admin user not found",
      );
    if (!parsed.username && targetUsers.length > 1) {
      throw new Error("Multiple admin users found. Please specify --username.");
    }
    const target = targetUsers[0]!;

    const updated = await db
      .update(userTable)
      .set({ passwordHash, updatedAtMs: nowMs })
      .where(eq(userTable.id, target.id))
      .returning({ id: userTable.id, username: userTable.username });

    if (updated.length === 0) throw new Error("Failed to update password");

    await revokeUserSessions(db, updated[0]!.id, nowMs);
    removeCredentialFile(dbPath);

    if (parsed.password) {
      console.log(`Password reset for user: ${updated[0]!.username}`);
    } else {
      console.log(`Password reset: username=${updated[0]!.username} password=${password}`);
    }
    return;
  }

  const agentId = crypto.randomUUID();
  const token = parsed.token ?? randomAgentToken(32);
  const tokenHash = sha256Hex(token);

  let groupId: string | undefined;
  if (parsed.groupName) {
    const existingGroup = await db
      .select({ id: agentGroupTable.id })
      .from(agentGroupTable)
      .where(eq(agentGroupTable.name, parsed.groupName))
      .limit(1);

    if (existingGroup.length > 0) {
      groupId = existingGroup[0]!.id;
    } else {
      groupId = crypto.randomUUID();
      await db.insert(agentGroupTable).values({
        id: groupId,
        name: parsed.groupName,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
  }

  await db.insert(agentTable).values({
    id: agentId,
    tokenHash,
    name: parsed.name,
    groupId,
    isPublic: parsed.isPublic,
    tagsJson: "[]",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });

  await db.insert(agentStatusTable).values({
    agentId,
    online: false,
    updatedAtMs: nowMs,
  });

  await db.insert(agentBillingTable).values({
    agentId,
    quotaBytes: 0,
    mode: "sum",
    resetDay: 1,
    updatedAtMs: nowMs,
  });

  console.log(`Created agent: id=${agentId} token=${token}`);
}

await main();
