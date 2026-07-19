import type { ServerWebSocket } from "bun";

/**
 * Send a final payload and close the socket. Swallows any send failure so the
 * close always happens.
 */
export function sendAndClose<T>(
  ws: ServerWebSocket<T>,
  payload: Uint8Array,
  code = 4001,
  reason = "unauthorized",
): void {
  try {
    ws.send(payload);
  } finally {
    ws.close(code, reason);
  }
}

export function normalizeOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
