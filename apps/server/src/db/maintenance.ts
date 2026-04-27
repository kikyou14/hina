import { createLogger } from "../logging/logger";
import type {
  MaintenanceMessage,
  MaintenanceRequest,
  MaintenanceResponse,
} from "./maintenance-protocol";
import workerSource from "./maintenance.worker.js" with { type: "text" };

const log = createLogger("db-maint");

export class MaintenanceBusyError extends Error {
  constructor() {
    super("db maintenance is already running");
    this.name = "MaintenanceBusyError";
  }
}

type Pending = {
  resolve: () => void;
  reject: (err: Error) => void;
};

export class DbMaintenance {
  private readonly dbPath: string;
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private initPromise: Promise<void> | null = null;
  private onInitResult: ((err: Error | null) => void) | null = null;
  private readonly inflight = new Map<number, Pending>();
  private nextId = 1;
  private busy = false;
  private closed = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  isBusy(): boolean {
    return this.busy;
  }

  vacuum(): Promise<void> {
    return this.call({ op: "vacuum" });
  }

  optimize(): Promise<void> {
    return this.call({ op: "optimize" });
  }

  vacuumInto(targetPath: string): Promise<void> {
    return this.call({ op: "vacuum_into", targetPath });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const closedErr = new Error("db maintenance closed");
    this.failAllInflight(closedErr);
    const initCb = this.onInitResult;
    this.onInitResult = null;
    if (initCb) initCb(closedErr);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.revokeWorkerUrl();
    this.initPromise = null;
    this.busy = false;
  }

  private async call(request: MaintenanceRequest): Promise<void> {
    if (this.closed) throw new Error("db maintenance closed");
    if (this.busy) throw new MaintenanceBusyError();
    this.busy = true;
    try {
      const worker = await this.ensureWorker();
      const id = this.nextId++;
      const done = new Promise<void>((resolve, reject) => {
        this.inflight.set(id, { resolve, reject });
      });
      const message: MaintenanceMessage = { kind: "call", id, request };
      worker.postMessage(message);
      await done;
    } finally {
      this.busy = false;
    }
  }

  private ensureWorker(): Promise<Worker> {
    if (this.closed) return Promise.reject(new Error("db maintenance closed"));
    if (this.worker && this.initPromise) {
      return this.initPromise.then(() => this.worker as Worker);
    }

    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const worker = new Worker(workerUrl, { type: "module" });
    this.worker = worker;
    this.workerUrl = workerUrl;

    worker.addEventListener("message", (event: MessageEvent<MaintenanceResponse>) => {
      this.handleMessage(event.data);
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      const err =
        event.error instanceof Error ? event.error : new Error(event.message || "worker error");
      log.error("db maintenance worker error", err);
      this.handleWorkerFailure(err);
    });

    this.initPromise = new Promise<void>((resolve, reject) => {
      this.onInitResult = (err) => (err ? reject(err) : resolve());
    });

    const init: MaintenanceMessage = { kind: "init", dbPath: this.dbPath };
    worker.postMessage(init);

    return this.initPromise.then(() => worker);
  }

  private handleMessage(message: MaintenanceResponse): void {
    if (message.kind === "ready") {
      const cb = this.onInitResult;
      this.onInitResult = null;
      if (message.ok) {
        cb?.(null);
      } else {
        const err = new Error(message.error);
        if (this.worker) {
          this.worker.terminate();
          this.worker = null;
        }
        this.revokeWorkerUrl();
        this.initPromise = null;
        cb?.(err);
      }
      return;
    }

    const pending = this.inflight.get(message.id);
    if (!pending) return;
    this.inflight.delete(message.id);
    if (message.ok) {
      log.info(`maintenance op id=${message.id} took ${message.durationMs.toFixed(0)}ms`);
      pending.resolve();
    } else {
      pending.reject(new Error(message.error));
    }
  }

  private handleWorkerFailure(err: Error): void {
    this.failAllInflight(err);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.revokeWorkerUrl();
    this.initPromise = null;
    const initCb = this.onInitResult;
    this.onInitResult = null;
    if (initCb) initCb(err);
    this.busy = false;
  }

  private failAllInflight(err: Error): void {
    for (const pending of this.inflight.values()) pending.reject(err);
    this.inflight.clear();
  }

  private revokeWorkerUrl(): void {
    if (!this.workerUrl) return;
    URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
  }
}
