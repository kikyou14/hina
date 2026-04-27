import {
  chmodSync,
  createReadStream,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import type { AppContext } from "../../app";
import { MaintenanceBusyError } from "../../db/maintenance";
import { createLogger } from "../../logging/logger";
import {
  loadRuntimeAgentConfig,
  parseTelemetryIntervalMs,
  parseTelemetryJitterMs,
  saveRuntimeAgentConfig,
  validateRuntimeAgentConfig,
} from "../../settings/runtime";
import { isRecord } from "./parsing";
import { getProbeDispatcher } from "./shared";

const systemLog = createLogger("system");

function isMissingEntry(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT";
}

const PENDING_BACKUP_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/;

function cleanupOrphanedBackups(backupDir: string) {
  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch (err) {
    if (!isMissingEntry(err)) {
      systemLog.warn(`orphaned backup scan failed: dir=${backupDir}`, err);
    }
    return;
  }
  for (const name of entries) {
    if (!PENDING_BACKUP_RE.test(name)) continue;
    try {
      unlinkSync(join(backupDir, name));
    } catch (err) {
      systemLog.warn(`orphaned backup unlink failed: file=${name}`, err);
    }
  }
}

export function registerAdminSystemRoutes(router: Hono<AppContext>, dbPath: string) {
  const backupDir = join(dirname(dbPath), "backups");
  cleanupOrphanedBackups(backupDir);

  router.get("/system/runtime-config", async (c) => {
    const db = c.get("db");
    const runtimeStore = c.get("runtimeAgentConfig");

    const loaded = await loadRuntimeAgentConfig(db);
    runtimeStore.setCurrent({
      current: loaded.current,
      source: loaded.source,
    });

    return c.json({
      current: loaded.current,
      defaults: runtimeStore.getDefaults(),
      source: loaded.source,
    });
  });

  router.patch("/system/runtime-config", async (c) => {
    const db = c.get("db");
    const runtimeStore = c.get("runtimeAgentConfig");
    const probeDispatcher = getProbeDispatcher(c);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ code: "bad_json" }, 400);
    }
    if (!isRecord(body)) return c.json({ code: "bad_request" }, 400);

    const current = runtimeStore.getCurrent();
    const patch: Partial<{
      telemetryIntervalMs: number;
      telemetryJitterMs: number;
    }> = {};

    if (body["telemetryIntervalMs"] !== undefined) {
      const value = parseTelemetryIntervalMs(body["telemetryIntervalMs"]);
      if (value === null) return c.json({ code: "invalid_telemetry_interval_ms" }, 400);
      patch.telemetryIntervalMs = value;
    }

    if (body["telemetryJitterMs"] !== undefined) {
      const value = parseTelemetryJitterMs(body["telemetryJitterMs"]);
      if (value === null) return c.json({ code: "invalid_telemetry_jitter_ms" }, 400);
      patch.telemetryJitterMs = value;
    }

    const next = validateRuntimeAgentConfig({
      telemetryIntervalMs: patch.telemetryIntervalMs ?? current.telemetryIntervalMs,
      telemetryJitterMs: patch.telemetryJitterMs ?? current.telemetryJitterMs,
    });

    await saveRuntimeAgentConfig(db, patch);
    runtimeStore.setCurrent({
      current: next,
      source: {
        telemetryIntervalMs:
          patch.telemetryIntervalMs !== undefined
            ? "db"
            : runtimeStore.getSource().telemetryIntervalMs,
        telemetryJitterMs:
          patch.telemetryJitterMs !== undefined ? "db" : runtimeStore.getSource().telemetryJitterMs,
      },
    });

    const pushed = probeDispatcher ? await probeDispatcher.pushRuntimeConfigAll() : 0;

    return c.json({
      ok: true,
      current: runtimeStore.getCurrent(),
      defaults: runtimeStore.getDefaults(),
      source: runtimeStore.getSource(),
      pushed,
    });
  });

  router.get("/system/asn-db", (c) => {
    const service = c.get("asnLookupService");
    if (!service) return c.json({ loaded: false, fileAgeMs: null, refreshing: false });
    return c.json(service.status());
  });

  router.post("/system/asn-db/refresh", async (c) => {
    const service = c.get("asnLookupService");
    if (!service) return c.json({ ok: false, error: "ASN service not available" }, 500);
    const result = await service.refresh();
    return c.json(result, result.ok ? 200 : 500);
  });

  // ── SQLite database info & maintenance ──

  router.get("/system/db", (c) => {
    const sqlite = c.get("db").$client;
    const dbPath = sqlite.filename;

    let dbSizeBytes = 0;
    let walSizeBytes = 0;
    try {
      dbSizeBytes = statSync(dbPath).size;
    } catch {}
    try {
      walSizeBytes = statSync(`${dbPath}-wal`).size;
    } catch {}

    const pageSize =
      (sqlite.query("PRAGMA page_size").get() as { page_size: number } | null)?.page_size ?? 0;
    const pageCount =
      (sqlite.query("PRAGMA page_count").get() as { page_count: number } | null)?.page_count ?? 0;
    const freelistCount =
      (sqlite.query("PRAGMA freelist_count").get() as { freelist_count: number } | null)
        ?.freelist_count ?? 0;

    return c.json({ dbSizeBytes, walSizeBytes, pageSize, pageCount, freelistCount });
  });

  router.post("/system/db/vacuum", async (c) => {
    const maintenance = c.get("dbMaintenance");
    try {
      await maintenance.vacuum();
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof MaintenanceBusyError) {
        return c.json({ ok: false, code: "maintenance_busy" }, 409);
      }
      systemLog.error("VACUUM failed", err);
      return c.json({ ok: false, code: "database_error" }, 500);
    }
  });

  router.post("/system/db/optimize", async (c) => {
    const maintenance = c.get("dbMaintenance");
    try {
      await maintenance.optimize();
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof MaintenanceBusyError) {
        return c.json({ ok: false, code: "maintenance_busy" }, 409);
      }
      systemLog.error("PRAGMA optimize failed", err);
      return c.json({ ok: false, code: "database_error" }, 500);
    }
  });

  const BACKUP_TOKEN_TTL_MS = 5 * 60 * 1000;

  type PendingBackup = {
    filePath: string;
    filename: string;
    sizeBytes: number;
    timer: ReturnType<typeof setTimeout>;
  };

  const pendingBackups = new Map<string, PendingBackup>();

  function removePendingBackup(token: string) {
    const entry = pendingBackups.get(token);
    if (!entry) return;
    pendingBackups.delete(token);
    clearTimeout(entry.timer);
    try {
      unlinkSync(entry.filePath);
    } catch (err) {
      if (!isMissingEntry(err)) {
        systemLog.warn(`pending backup unlink failed: file=${entry.filePath}`, err);
      }
    }
  }

  router.post("/system/db/backup", async (c) => {
    const maintenance = c.get("dbMaintenance");
    if (pendingBackups.size > 0 || maintenance.isBusy()) {
      return c.json({ ok: false, code: "backup_already_pending" }, 409);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `hina-backup-${timestamp}.sqlite`;
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const filePath = join(backupDir, `${crypto.randomUUID()}.sqlite`);

    try {
      await maintenance.vacuumInto(filePath);
      chmodSync(filePath, 0o600);

      const token = crypto.randomUUID();
      const sizeBytes = statSync(filePath).size;
      const timer = setTimeout(() => removePendingBackup(token), BACKUP_TOKEN_TTL_MS);
      pendingBackups.set(token, { filePath, filename, sizeBytes, timer });

      return c.json({ ok: true, token, filename, sizeBytes });
    } catch (err) {
      try {
        unlinkSync(filePath);
      } catch (cleanupErr) {
        if (!isMissingEntry(cleanupErr)) {
          systemLog.warn(`backup cleanup after failure failed: file=${filePath}`, cleanupErr);
        }
      }
      if (err instanceof MaintenanceBusyError) {
        return c.json({ ok: false, code: "backup_already_pending" }, 409);
      }
      systemLog.error("Database backup failed", err);
      return c.json({ ok: false, code: "database_error" }, 500);
    }
  });

  router.get("/system/db/backup/download", (c) => {
    const token = c.req.query("token");
    if (!token) return c.json({ code: "missing_token" }, 400);

    const entry = pendingBackups.get(token);
    if (!entry) return c.json({ code: "invalid_or_expired_token" }, 404);

    pendingBackups.delete(token);
    clearTimeout(entry.timer);

    let fd: number;
    try {
      fd = openSync(entry.filePath, "r");
    } catch (err) {
      systemLog.error(`pending backup open failed: file=${entry.filePath}`, err);
      return c.json({ code: "database_error" }, 500);
    }

    try {
      unlinkSync(entry.filePath);
    } catch (err) {
      if (!isMissingEntry(err)) {
        systemLog.warn(`pending backup unlink failed: file=${entry.filePath}`, err);
      }
    }

    // Bun.file(fd) does not close the descriptor; createReadStream with
    // autoClose closes it on end/error/destroy (the last fires when the
    // Web stream is cancelled on client abort)
    const nodeStream = createReadStream("", { fd, autoClose: true });
    nodeStream.on("error", (err) => {
      systemLog.warn(`pending backup stream errored: file=${entry.filePath}`, err);
    });

    return new Response(Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${entry.filename}"`,
        "content-length": String(entry.sizeBytes),
        "cache-control": "no-store",
      },
    });
  });
}
