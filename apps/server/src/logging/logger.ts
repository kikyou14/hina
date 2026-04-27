import { type LogLevel, logBuffer, originalConsole } from "./buffer";

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string, err?: unknown) => void;
  error: (msg: string, err?: unknown) => void;
};

function emit(level: LogLevel, source: string, msg: string, err?: unknown) {
  // Ring buffer: store stack trace as text when an error is provided
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : err !== undefined ? String(err) : undefined;
  logBuffer.push({ tsMs: Date.now(), level, source, msg: detail ? `${msg}\n${detail}` : msg });

  // Terminal: pass error object separately for native formatting (colors, structured stack)
  const tag = `[${source}]`;
  const args: unknown[] = err !== undefined ? [tag, msg, err] : [tag, msg];
  if (level === "error") originalConsole.error(...args);
  else if (level === "warn") originalConsole.warn(...args);
  else originalConsole.log(...args);
}

export function createLogger(source: string): Logger {
  return {
    info: (msg) => emit("info", source, msg),
    warn: (msg, err?) => emit("warn", source, msg, err),
    error: (msg, err?) => emit("error", source, msg, err),
  };
}
