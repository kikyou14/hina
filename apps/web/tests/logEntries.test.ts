import { describe, expect, test } from "bun:test";
import type { AdminLogEntry } from "../src/api/adminLogs";
import { appendUniqueLogEntries } from "../src/pages/admin/logEntries";

function entry(id: string): AdminLogEntry {
  return { id, level: "info", msg: id, source: "test", tsMs: 1000 };
}

describe("appendUniqueLogEntries", () => {
  test("deduplicates both existing and incoming IDs", () => {
    const current = [entry("a")];
    const result = appendUniqueLogEntries(current, [entry("a"), entry("b"), entry("b")]);

    expect(result.map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("keeps the existing array when the response contains only duplicates", () => {
    const current = [entry("a")];
    expect(appendUniqueLogEntries(current, [entry("a")])).toBe(current);
  });

  test("trims from the head without changing retained IDs", () => {
    const result = appendUniqueLogEntries(
      [entry("a"), entry("b"), entry("c")],
      [entry("d"), entry("e")],
      3,
    );

    expect(result.map((item) => item.id)).toEqual(["c", "d", "e"]);
  });
});
