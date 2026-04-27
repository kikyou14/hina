import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbMaintenance, MaintenanceBusyError } from "./maintenance";

const dirsToCleanup: string[] = [];

afterEach(() => {
  while (dirsToCleanup.length > 0) {
    const dir = dirsToCleanup.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDb(opts: { rows?: number; valueBytes?: number } = {}): {
  dir: string;
  path: string;
} {
  const rows = opts.rows ?? 200;
  const valueBytes = opts.valueBytes ?? 64;
  const dir = mkdtempSync(join(tmpdir(), "hina-maint-"));
  dirsToCleanup.push(dir);
  const path = join(dir, "test.sqlite");
  const sqlite = new Database(path);
  sqlite.run("CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT)");
  const insert = sqlite.prepare("INSERT INTO t (v) VALUES (?)");
  const value = "x".repeat(valueBytes);
  sqlite.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(value);
  })();
  insert.finalize();
  sqlite.close();
  return { dir, path };
}

describe("DbMaintenance", () => {
  it("runs VACUUM without throwing", async () => {
    const { path } = makeTmpDb();
    const maintenance = new DbMaintenance(path);
    try {
      await maintenance.vacuum();
    } finally {
      await maintenance.close();
    }
  });

  it("runs PRAGMA optimize", async () => {
    const { path } = makeTmpDb();
    const maintenance = new DbMaintenance(path);
    try {
      await maintenance.optimize();
    } finally {
      await maintenance.close();
    }
  });

  it("creates a valid backup via VACUUM INTO", async () => {
    const { dir, path } = makeTmpDb();
    const backupPath = join(dir, "backup.sqlite");
    const maintenance = new DbMaintenance(path);
    try {
      await maintenance.vacuumInto(backupPath);

      const backup = new Database(backupPath, { readonly: true });
      const row = backup.query("SELECT COUNT(*) AS c FROM t").get() as { c: number } | null;
      backup.close();
      expect(row?.c).toBe(200);
    } finally {
      await maintenance.close();
    }
  });

  it("rejects overlapping calls with MaintenanceBusyError", async () => {
    const { path } = makeTmpDb();
    const maintenance = new DbMaintenance(path);
    try {
      const first = maintenance.vacuum();
      await expect(maintenance.optimize()).rejects.toBeInstanceOf(MaintenanceBusyError);
      await first;
    } finally {
      await maintenance.close();
    }
  });

  it("serializes sequential calls", async () => {
    const { path } = makeTmpDb();
    const maintenance = new DbMaintenance(path);
    try {
      await maintenance.vacuum();
      await maintenance.optimize();
      await maintenance.vacuum();
    } finally {
      await maintenance.close();
    }
  });

  it("rejects calls after close", async () => {
    const { path } = makeTmpDb();
    const maintenance = new DbMaintenance(path);
    await maintenance.close();
    await expect(maintenance.vacuum()).rejects.toThrow("db maintenance closed");
  });

  it("rejects an in-flight call when close() interrupts worker init", async () => {
    const { path } = makeTmpDb();
    const maintenance = new DbMaintenance(path);
    const pending = maintenance.vacuum();
    // Close before init has a chance to settle — the in-flight call must
    // reject rather than hang on the dropped ready message.
    await maintenance.close();
    await expect(pending).rejects.toThrow("db maintenance closed");
  });

  it("recovers after a worker init failure", async () => {
    const { dir } = makeTmpDb();
    const missingPath = join(dir, "does-not-exist", "db.sqlite");
    const maintenance = new DbMaintenance(missingPath);
    try {
      await expect(maintenance.vacuum()).rejects.toThrow();
      // A second call must not be poisoned by the first init failure — the
      // driver should tear the worker down and allow a fresh spawn.
      await expect(maintenance.vacuum()).rejects.toThrow();
    } finally {
      await maintenance.close();
    }
  });

  it("does not block the main event loop during VACUUM", async () => {
    // Bulk up the fixture so VACUUM has measurable work to do; the intent
    // is to observe event-loop iterations while the worker runs, not to
    // race against the vacuum finishing first.
    const { path } = makeTmpDb({ rows: 5000, valueBytes: 512 });
    const maintenance = new DbMaintenance(path);
    try {
      let ticks = 0;
      let stopped = false;
      const tick = () => {
        if (stopped) return;
        ticks++;
        setImmediate(tick);
      };
      setImmediate(tick);

      await maintenance.vacuum();
      stopped = true;

      // setImmediate fires once per event-loop iteration without the
      // minimum-delay clamp that setInterval has. A synchronous VACUUM
      // would block the loop entirely and produce ~0 ticks; the worker
      // setup lets the main thread keep iterating while we await.
      expect(ticks).toBeGreaterThan(1);
    } finally {
      await maintenance.close();
    }
  });
});
