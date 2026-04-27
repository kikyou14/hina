import { Database } from "bun:sqlite";

let db = null;

function configureConnection(database) {
  database.run("PRAGMA journal_mode = WAL");
  database.run("PRAGMA synchronous = NORMAL");
  database.run("PRAGMA busy_timeout = 30000");
  database.run("PRAGMA temp_store = MEMORY");
}

function escapeSqliteStringLiteral(value) {
  return value.replace(/'/g, "''");
}

function run(request) {
  if (!db) throw new Error("maintenance worker not initialized");
  switch (request.op) {
    case "vacuum":
      db.run("VACUUM");
      return;
    case "optimize":
      db.run("PRAGMA optimize");
      return;
    case "vacuum_into":
      // VACUUM INTO requires a literal string, not a bind parameter.
      db.run(`VACUUM INTO '${escapeSqliteStringLiteral(request.targetPath)}'`);
      return;
  }
}

function post(message) {
  self.postMessage(message);
}

self.onmessage = (event) => {
  const message = event.data;

  if (message.kind === "init") {
    try {
      db = new Database(message.dbPath);
      configureConnection(db);
      post({ kind: "ready", ok: true });
    } catch (err) {
      post({ kind: "ready", ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (message.kind === "call") {
    const startedAt = performance.now();
    try {
      run(message.request);
      post({
        kind: "result",
        id: message.id,
        ok: true,
        durationMs: performance.now() - startedAt,
      });
    } catch (err) {
      post({
        kind: "result",
        id: message.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
