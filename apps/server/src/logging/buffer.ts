import { randomUUID } from "node:crypto";
import util from "node:util";

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  id: string;
  tsMs: number;
  level: LogLevel;
  source: string;
  msg: string;
};

export type LogEntryInput = Omit<LogEntry, "id">;

export type LogListResult = {
  entries: LogEntry[];
  nextCursor: string;
  hasMore: boolean;
  reset: boolean;
};

const DEFAULT_MAX_ENTRIES = 2000;
const MAX_MSG_LEN = 16_384;

function clampText(value: string): string {
  if (value.length <= MAX_MSG_LEN) return value;
  return value.slice(0, MAX_MSG_LEN);
}

export class LogRingBuffer {
  private readonly maxEntries: number;
  private readonly generation: string;
  private entries: LogEntry[] = [];
  private sequence = 0;

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES, generation: string = randomUUID()) {
    this.maxEntries = Math.min(Math.max(100, Math.floor(maxEntries)), 50_000);
    this.generation = generation;
  }

  push(entry: LogEntryInput): LogEntry {
    const stored = {
      ...entry,
      id: this.cursorFor(++this.sequence),
      msg: clampText(entry.msg),
    };
    this.entries.push(stored);
    const overflow = this.entries.length - this.maxEntries;
    if (overflow > 0) this.entries.splice(0, overflow);
    return stored;
  }

  list(args?: { after?: string; sinceTsMs?: number; limit?: number }): LogListResult {
    const limit = this.clampLimit(args?.limit);
    const after = args?.after;

    if (after !== undefined) {
      const parsed = this.parseCursor(after);
      if (!parsed || parsed.generation !== this.generation) {
        return this.initialPage(limit, true);
      }

      const oldestSequence = this.sequence - this.entries.length + 1;
      const cursorIsBeforeAvailableRange = parsed.sequence < oldestSequence - 1;
      const cursorIsAhead = parsed.sequence > this.sequence;
      if (cursorIsBeforeAvailableRange || cursorIsAhead) {
        return this.initialPage(limit, true);
      }

      const startIndex = Math.max(0, parsed.sequence - oldestSequence + 1);
      const entries = this.entries.slice(startIndex, startIndex + limit);
      return {
        entries,
        nextCursor: entries.at(-1)?.id ?? this.cursorFor(this.sequence),
        hasMore: startIndex + entries.length < this.entries.length,
        reset: false,
      };
    }

    const sinceTsMs = args?.sinceTsMs;
    if (sinceTsMs !== undefined && Number.isFinite(sinceTsMs)) {
      const matching = this.entries.filter((entry) => entry.tsMs > sinceTsMs);
      const entries = matching.slice(Math.max(0, matching.length - limit));
      return {
        entries,
        nextCursor: this.cursorFor(this.sequence),
        hasMore: false,
        reset: false,
      };
    }

    return this.initialPage(limit, false);
  }

  private clampLimit(limitRaw: number | undefined): number {
    if (limitRaw === undefined || !Number.isFinite(limitRaw)) return 200;
    return Math.min(Math.max(0, Math.floor(limitRaw)), this.maxEntries);
  }

  private initialPage(limit: number, reset: boolean): LogListResult {
    const entries = this.entries.slice(Math.max(0, this.entries.length - limit));
    return {
      entries,
      nextCursor: this.cursorFor(this.sequence),
      hasMore: false,
      reset,
    };
  }

  private cursorFor(sequence: number): string {
    return `${this.generation}:${sequence}`;
  }

  private parseCursor(cursor: string): { generation: string; sequence: number } | null {
    const separator = cursor.lastIndexOf(":");
    if (separator <= 0) return null;

    const generation = cursor.slice(0, separator);
    const sequence = Number(cursor.slice(separator + 1));
    if (!Number.isSafeInteger(sequence) || sequence < 0) return null;
    return { generation, sequence };
  }
}

export const logBuffer = new LogRingBuffer();

export const originalConsole = Object.freeze({
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
});

export function installConsoleCapture(buffer: LogRingBuffer = logBuffer) {
  const wrap = (level: LogLevel, fn: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      try {
        buffer.push({ tsMs: Date.now(), level, source: "system", msg: util.format(...args) });
      } catch {
        buffer.push({ tsMs: Date.now(), level, source: "system", msg: "[log format error]" });
      }
      fn(...args);
    };
  };

  console.log = wrap("info", originalConsole.log);
  console.info = wrap("info", originalConsole.info);
  console.warn = wrap("warn", originalConsole.warn);
  console.error = wrap("error", originalConsole.error);

  return () => {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  };
}
