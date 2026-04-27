import { isApiError } from "@/api/http";

export type UserErrorAction =
  | "request"
  | "load"
  | "create"
  | "save"
  | "update"
  | "delete"
  | "login"
  | "test";

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

type UserErrorMessageOptions = {
  action?: UserErrorAction;
  fallback?: string;
  codeMessages?: Partial<Record<string, string>>;
};

const ACTION_FALLBACK_KEYS: Record<UserErrorAction, string> = {
  request: "common.errors.requestFailed",
  load: "common.errors.loadFailed",
  create: "common.errors.createFailed",
  save: "common.errors.saveFailed",
  update: "common.errors.updateFailed",
  delete: "common.errors.deleteFailed",
  login: "login.loginFailed",
  test: "common.errors.testFailed",
};

export function getUserErrorMessage(
  err: unknown,
  t: TranslateFn,
  options: UserErrorMessageOptions = {},
): string {
  const fallback = options.fallback ?? t(ACTION_FALLBACK_KEYS[options.action ?? "request"]);

  if (isApiError(err)) {
    if (err.code) {
      const codeMessage = options.codeMessages?.[err.code];
      if (codeMessage) return codeMessage;
      if (err.code === "rate_limit_exceeded") return t("common.errors.rateLimited");
    }

    if (err.status === 401) return t("common.errors.unauthorized");
    if (err.status === 403) return t("common.errors.forbidden");
    if (err.status === 404) return t("common.errors.notFound");
    if (err.status === 409) return t("common.errors.conflict");
    if (err.status === 413) return t("common.errors.payloadTooLarge");
    if (err.status === 429) return t("common.errors.rateLimited");
    if (err.status >= 500) return t("common.errors.server");

    return fallback;
  }

  if (isLikelyNetworkError(err)) return t("common.errors.network");

  return fallback;
}

function isLikelyNetworkError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      (err.name === "AbortError" || err.name === "NetworkError"))
  );
}
