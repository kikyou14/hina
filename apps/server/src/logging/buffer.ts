import util from "node:util";

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  tsMs: number;
  level: LogLevel;
  source: string;
  msg: string;
};

const DEFAULT_MAX_ENTRIES = 2000;
const MAX_MSG_LEN = 16_384;

function clampText(value: string): string {
  if (value.length <= MAX_MSG_LEN) return value;
  return value.slice(0, MAX_MSG_LEN);
}

export class LogRingBuffer {
  private readonly maxEntries: number;
  private entries: LogEntry[] = [];

  constructor(maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.min(Math.max(100, Math.floor(maxEntries)), 50_000);
  }

  push(entry: LogEntry) {
    this.entries.push({ ...entry, msg: clampText(entry.msg) });
    const overflow = this.entries.length - this.maxEntries;
    if (overflow > 0) this.entries.splice(0, overflow);
  }

  list(args?: { sinceTsMs?: number; limit?: number }): LogEntry[] {
    const sinceTsMs = args?.sinceTsMs;
    const limitRaw = args?.limit ?? 200;
    const limit = Math.min(Math.max(1, Math.floor(limitRaw)), this.maxEntries);

    let out = this.entries;
    if (sinceTsMs !== undefined && Number.isFinite(sinceTsMs)) {
      out = out.filter((e) => e.tsMs > sinceTsMs);
    }

    if (out.length > limit) out = out.slice(out.length - limit);
    return out;
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
