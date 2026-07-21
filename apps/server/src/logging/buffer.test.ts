import { describe, expect, test } from "bun:test";
import { LogRingBuffer } from "./buffer";

function push(buffer: LogRingBuffer, msg: string, tsMs: number = 1000) {
  return buffer.push({ level: "info", msg, source: "test", tsMs });
}

describe("LogRingBuffer cursor pagination", () => {
  test("does not lose entries that share a millisecond timestamp", () => {
    const buffer = new LogRingBuffer(100, "run-a");
    const emptyCursor = buffer.list({ limit: 0 }).nextCursor;
    const first = push(buffer, "first");
    const second = push(buffer, "second");
    const third = push(buffer, "third");

    const page1 = buffer.list({ after: emptyCursor, limit: 2 });
    expect(page1).toEqual({
      entries: [first, second],
      nextCursor: second.id,
      hasMore: true,
      reset: false,
    });

    const page2 = buffer.list({ after: page1.nextCursor, limit: 2 });
    expect(page2).toEqual({
      entries: [third],
      nextCursor: third.id,
      hasMore: false,
      reset: false,
    });
  });

  test("returns the latest page for an initial load", () => {
    const buffer = new LogRingBuffer(100, "run-a");
    push(buffer, "first");
    const second = push(buffer, "second");
    const third = push(buffer, "third");

    expect(buffer.list({ limit: 2 })).toEqual({
      entries: [second, third],
      nextCursor: third.id,
      hasMore: false,
      reset: false,
    });
  });

  test("asks the client to reset when the cursor belongs to another generation", () => {
    const buffer = new LogRingBuffer(100, "run-b");
    const first = push(buffer, "first");
    const second = push(buffer, "second");

    expect(buffer.list({ after: "run-a:4", limit: 2 })).toEqual({
      entries: [first, second],
      nextCursor: second.id,
      hasMore: false,
      reset: true,
    });
  });

  test("asks the client to reset after unread entries overflow the ring", () => {
    const buffer = new LogRingBuffer(100, "run-a");
    const emptyCursor = buffer.list({ limit: 0 }).nextCursor;
    for (let index = 0; index < 101; index += 1) {
      push(buffer, `entry-${index}`, 1000 + index);
    }

    const page = buffer.list({ after: emptyCursor, limit: 10 });
    expect(page.reset).toBe(true);
    expect(page.entries).toHaveLength(10);
    expect(page.entries[0]?.msg).toBe("entry-91");
    expect(page.entries.at(-1)?.msg).toBe("entry-100");
  });

  test("keeps the timestamp query as a rolling-deploy compatibility path", () => {
    const buffer = new LogRingBuffer(100, "run-a");
    push(buffer, "old", 1000);
    const recent = push(buffer, "recent", 1001);

    expect(buffer.list({ sinceTsMs: 1000, limit: 10 }).entries).toEqual([recent]);
  });
});
