import { afterEach, describe, expect, test } from "bun:test";

import { ApiError, fetchJson } from "../src/api/http";
import { getUserErrorMessage } from "../src/lib/userErrors";

const originalFetch = globalThis.fetch;

const messages: Record<string, string> = {
  "common.errors.loadFailed": "Unable to load data.",
  "common.errors.network": "Network connection failed.",
  "common.errors.rateLimited": "Too many attempts.",
  "common.errors.server": "Service unavailable.",
  "common.errors.unauthorized": "Session expired.",
  "common.errors.requestFailed": "Request failed.",
  "login.invalidCredentials": "Invalid credentials.",
  "login.loginFailed": "Login failed.",
};

function t(key: string): string {
  return messages[key] ?? key;
}

function mockFetch(response: Response) {
  globalThis.fetch = (() => Promise.resolve(response)) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getUserErrorMessage", () => {
  test("maps server errors without exposing status or backend code", () => {
    const message = getUserErrorMessage(new ApiError({ status: 500, code: "internal_error" }), t, {
      action: "load",
    });

    expect(message).toBe("Service unavailable.");
    expect(message).not.toContain("internal_error");
    expect(message).not.toContain("500");
  });

  test("uses explicit code mappings for known user-facing errors", () => {
    expect(
      getUserErrorMessage(new ApiError({ status: 401, code: "invalid_credentials" }), t, {
        action: "login",
        fallback: t("login.loginFailed"),
        codeMessages: {
          invalid_credentials: t("login.invalidCredentials"),
        },
      }),
    ).toBe("Invalid credentials.");
  });

  test("does not render arbitrary Error.message text", () => {
    const message = getUserErrorMessage(new Error("GET /api/admin/agents http 500"), t, {
      action: "load",
    });

    expect(message).toBe("Unable to load data.");
  });

  test("shows a network recovery message for fetch failures", () => {
    expect(getUserErrorMessage(new TypeError("Failed to fetch"), t, { action: "load" })).toBe(
      "Network connection failed.",
    );
  });
});

describe("fetchJson errors", () => {
  test("keeps API error metadata while using a safe message", async () => {
    mockFetch(
      new Response(JSON.stringify({ code: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(fetchJson("/api/admin/agents")).rejects.toMatchObject({
      name: "ApiError",
      message: "Request failed",
      status: 500,
      code: "internal_error",
      details: { code: "internal_error" },
    });
  });

  test("does not retain raw non-json HTTP error text", async () => {
    mockFetch(new Response("GET /api/internal raw stack http 500", { status: 500 }));

    try {
      await fetchJson("/api/admin/agents");
      throw new Error("Expected fetchJson to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toBe("Request failed");
      expect((err as ApiError).details).toBeUndefined();
    }
  });
});
