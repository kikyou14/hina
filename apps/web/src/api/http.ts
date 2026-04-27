import { isRecord } from "@/lib/typeGuards";

export class ApiError extends Error {
  public readonly status: number;
  public readonly code?: string;
  public readonly details?: unknown;

  constructor(args: { status: number; code?: string; details?: unknown }) {
    super("Request failed");
    this.name = "ApiError";
    this.status = args.status;
    this.code = args.code;
    this.details = args.details;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function isUnauthorizedError(err: unknown): boolean {
  return isApiError(err) && err.status === 401;
}

export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const resp = await fetch(input, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });

  if (resp.status === 204) {
    return undefined as T;
  }

  const text = await resp.text();
  const data = text ? (safeJsonParse(text) ?? text) : null;

  if (!resp.ok) {
    const code =
      isRecord(data) && typeof data["code"] === "string" ? (data["code"] as string) : undefined;
    throw new ApiError({
      status: resp.status,
      code,
      details: isRecord(data) ? data : undefined,
    });
  }

  return data as T;
}

export function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
