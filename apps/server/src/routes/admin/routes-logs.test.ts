import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppContext } from "../../app";
import { LogRingBuffer } from "../../logging/buffer";
import { registerAdminLogRoutes } from "./routes-logs";

describe("admin log routes", () => {
  test("returns an opaque cursor and paginates from it", async () => {
    const buffer = new LogRingBuffer(100, "route-test");
    const app = new Hono<AppContext>();
    registerAdminLogRoutes(app, buffer);

    const cursorResponse = await app.request("/logs?limit=0");
    expect(cursorResponse.status).toBe(200);
    const cursorBody = (await cursorResponse.json()) as {
      entries: unknown[];
      nextCursor: string;
    };
    expect(cursorBody.entries).toEqual([]);
    expect(cursorBody.nextCursor).toBe("route-test:0");

    buffer.push({ level: "info", msg: "first", source: "test", tsMs: 1000 });
    buffer.push({ level: "info", msg: "second", source: "test", tsMs: 1000 });

    const pageResponse = await app.request(
      `/logs?after=${encodeURIComponent(cursorBody.nextCursor)}&limit=1`,
    );
    expect(pageResponse.status).toBe(200);
    const pageBody = (await pageResponse.json()) as {
      entries: Array<{ id: string; msg: string }>;
      nextCursor: string;
      hasMore: boolean;
      reset: boolean;
    };
    expect(pageBody.entries.map((entry) => entry.msg)).toEqual(["first"]);
    expect(pageBody.nextCursor).toBe(pageBody.entries[0]?.id);
    expect(pageBody.hasMore).toBe(true);
    expect(pageBody.reset).toBe(false);
  });
});
