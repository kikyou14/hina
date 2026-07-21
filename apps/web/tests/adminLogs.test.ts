import { afterEach, describe, expect, test } from "bun:test";
import { getAdminLogs } from "../src/api/adminLogs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getAdminLogs", () => {
  test("forwards the opaque cursor and abort signal", async () => {
    const controller = new AbortController();
    let requestUrl = "";
    let requestSignal: AbortSignal | null | undefined;
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      requestSignal = init?.signal;
      return Response.json({
        entries: [],
        hasMore: false,
        nextCursor: "run-a:4",
        nowMs: 1000,
        reset: false,
      });
    };

    await getAdminLogs({ after: "run-a:3", limit: 25, signal: controller.signal });

    expect(requestUrl).toBe("/api/admin/logs?after=run-a%3A3&limit=25");
    expect(requestSignal).toBe(controller.signal);
  });
});
