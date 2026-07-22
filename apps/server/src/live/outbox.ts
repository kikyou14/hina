export type OutboxSink = {
  send: (data: string) => number;
  cork: (fn: () => void) => unknown;
  close: (code?: number, reason?: string) => void;
};

export type OutboxOptions = {
  maxPendingEntries?: number;
  maxPendingBytes?: number;
};

type PendingFrame = {
  raw: string;
  bytes: number;
};

const DEFAULT_MAX_PENDING_ENTRIES = 2_048;
const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;
const BACKPRESSURE_CLOSE_CODE = 1013;
const BACKPRESSURE_CLOSE_REASON = "backpressure_limit";

export class Outbox {
  private readonly maxPendingEntries: number;
  private readonly maxPendingBytes: number;
  private backpressured = false;
  private closed = false;
  private readonly pending = new Map<string, PendingFrame>();
  private pendingBytesTotal = 0;

  constructor(options: OutboxOptions = {}) {
    this.maxPendingEntries = options.maxPendingEntries ?? DEFAULT_MAX_PENDING_ENTRIES;
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES;
  }

  get isBackpressured(): boolean {
    return this.backpressured;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pendingSize(): number {
    return this.pending.size;
  }

  get pendingBytes(): number {
    return this.pendingBytesTotal;
  }

  push(sink: OutboxSink, raw: string, key: string): void {
    if (this.closed) return;
    if (this.backpressured) {
      this.enqueuePending(sink, raw, key);
      return;
    }
    this.trySend(sink, raw);
  }

  drain(sink: OutboxSink): void {
    if (this.closed) return;
    this.backpressured = false;
    if (this.pending.size === 0) return;

    const entries = [...this.pending];
    this.pending.clear();
    this.pendingBytesTotal = 0;

    sink.cork(() => {
      for (let i = 0; i < entries.length; i++) {
        const frame = entries[i]![1];
        if (this.trySend(sink, frame.raw)) continue;
        if (this.closed) return;
        for (let j = i + 1; j < entries.length; j++) {
          const [key, pendingFrame] = entries[j]!;
          this.pending.set(key, pendingFrame);
          this.pendingBytesTotal += pendingFrame.bytes;
        }
        return;
      }
    });
  }

  private enqueuePending(sink: OutboxSink, raw: string, key: string): void {
    const previous = this.pending.get(key);
    const frame = { raw, bytes: Buffer.byteLength(raw, "utf8") };
    const nextEntries = this.pending.size + (previous ? 0 : 1);
    const nextBytes = this.pendingBytesTotal - (previous?.bytes ?? 0) + frame.bytes;

    if (nextEntries > this.maxPendingEntries || nextBytes > this.maxPendingBytes) {
      this.markUnwritable(sink, BACKPRESSURE_CLOSE_CODE, BACKPRESSURE_CLOSE_REASON);
      return;
    }

    this.pending.delete(key);
    this.pending.set(key, frame);
    this.pendingBytesTotal = nextBytes;
  }

  private trySend(sink: OutboxSink, raw: string): boolean {
    if (this.closed) return false;
    let n: number;
    try {
      n = sink.send(raw);
    } catch {
      this.markUnwritable(sink);
      return false;
    }
    if (n > 0) return true;
    if (n < 0) {
      this.backpressured = true;
      return false;
    }
    this.markUnwritable(sink);
    return false;
  }

  private markUnwritable(sink: OutboxSink, code?: number, reason?: string): void {
    this.closed = true;
    this.backpressured = false;
    this.pending.clear();
    this.pendingBytesTotal = 0;
    try {
      sink.close(code, reason);
    } catch {}
  }
}
