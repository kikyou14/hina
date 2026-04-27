import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;
export type DbTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export type DbOptions = {
  dbPath: string;
  migrationsFolder: string;
};

export function createSqliteDatabase(dbPath: string): Database {
  const existed = existsSync(dbPath);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);

  sqlite.run("PRAGMA auto_vacuum = INCREMENTAL");
  if (!existed) sqlite.run("VACUUM");

  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA synchronous = NORMAL");
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run("PRAGMA busy_timeout = 5000");

  sqlite.run("PRAGMA cache_size = -131072");
  sqlite.run("PRAGMA temp_store = MEMORY");
  sqlite.run("PRAGMA mmap_size = 268435456");
  sqlite.run("PRAGMA wal_autocheckpoint = 2000");

  return sqlite;
}

export async function createDbClient(options: DbOptions): Promise<DbClient> {
  const sqlite = createSqliteDatabase(options.dbPath);
  const db = drizzle(sqlite, { schema });

  await migrate(db, { migrationsFolder: options.migrationsFolder });

  sqlite.run("PRAGMA optimize");

  return db;
}

export function closeDbClient(db: DbClient): void {
  const sqlite = db.$client;
  try {
    sqlite.run("PRAGMA optimize");
  } catch (err) {
    console.error("PRAGMA optimize on shutdown failed:", err);
  }
  sqlite.close();
}
