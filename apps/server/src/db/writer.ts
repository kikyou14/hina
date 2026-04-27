import type { DbClient, DbTx } from "./client";

type Task = {
  run: (tx: DbTx) => Promise<void> | void;
  resolve: () => void;
  reject: (err: unknown) => void;
};

export type DbWriterOptions = {
  maxBatchSize: number;
};

export class DbWriter {
  private readonly db: DbClient;
  private readonly options: DbWriterOptions;
  private readonly queue: Task[] = [];
  private readonly idleListeners: Array<() => void> = [];
  private draining = false;
  private scheduled = false;

  constructor(db: DbClient, options: Partial<DbWriterOptions> = {}) {
    this.db = db;
    this.options = {
      maxBatchSize: options.maxBatchSize ?? 64,
    };
  }

  enqueue(run: Task["run"]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ run, resolve, reject });
      this.scheduleDrain();
    });
  }

  async drain(): Promise<void> {
    while (!this.isIdle()) {
      await new Promise<void>((resolve) => this.idleListeners.push(resolve));
    }
  }

  private isIdle(): boolean {
    return this.queue.length === 0 && !this.draining;
  }

  private scheduleDrain() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => void this.processQueue());
  }

  private async processQueue() {
    this.scheduled = false;
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.options.maxBatchSize);
        try {
          await this.db.transaction(async (tx) => {
            for (const task of batch) {
              await task.run(tx);
            }
          });
          for (const task of batch) task.resolve();
        } catch (err) {
          for (const task of batch) task.reject(err);
        }
      }
    } finally {
      this.draining = false;
      try {
        if (this.queue.length > 0) {
          this.scheduleDrain();
        } else {
          this.notifyIdle();
        }
      } catch (err) {
        console.error("DbWriter post-drain failed", err);
      }
    }
  }

  private notifyIdle() {
    if (this.idleListeners.length === 0) return;
    const listeners = this.idleListeners.splice(0);
    for (const listener of listeners) listener();
  }
}
