import type { AlertChannelType, AlertMessageV1, Result, ValidationError } from "../types";

export type SendContext = {
  message: AlertMessageV1;
  publicBaseUrl: string | undefined;
  nowMs: number;
};

export type SendResult =
  | { kind: "ok" }
  | { kind: "retryable"; error: string }
  | { kind: "fatal"; error: string };

export interface Notifier<TConfig> {
  readonly type: AlertChannelType;

  /**
   * Parse and validate a raw config object.
   * When `existing` is provided (PATCH), missing fields fall back to it.
   */
  parseConfig(raw: unknown, existing?: TConfig): Result<TConfig, ValidationError[]>;

  /** Return a redacted view of the config safe for API responses. */
  redactConfig(config: TConfig): { config: unknown; meta: Record<string, unknown> };

  /** Send a notification. The caller handles retry/backoff. */
  send(ctx: SendContext, config: TConfig): Promise<SendResult>;
}

/**
 * Erased notifier type for call sites that handle multiple channel kinds and
 * cannot retain the per-channel config type statically (registry lookup,
 * dispatcher fan-out, tests, etc.).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNotifier = Notifier<any>;

export function withTimeout(timeoutMs: number): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}
