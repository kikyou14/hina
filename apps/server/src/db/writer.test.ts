import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { DbWriter } from "./writer";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE counter (
      id INTEGER PRIMARY KEY,
      value INTEGER NOT NULL
    );
    INSERT INTO counter (id, value) VALUES (1, 0);
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function readCounter(sqlite: Database): number {
  const row = sqlite.query("SELECT value FROM counter WHERE id = 1").get() as {
    value: number;
  };
  return row.value;
}

describe("DbWriter", () => {
  test("drain() resolves immediately when idle", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const writer = new DbWriter(db, { maxBatchSize: 8 });
      await writer.drain();
      expect(readCounter(sqlite)).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  test("drain() waits for all enqueued tasks to commit", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const writer = new DbWriter(db, { maxBatchSize: 4 });

      // Fire-and-forget 10 increments; none are awaited individually.
      for (let i = 0; i < 10; i++) {
        void writer.enqueue(async (tx) => {
          await tx.run(sql`UPDATE counter SET value = value + 1 WHERE id = 1`);
        });
      }

      // Nothing has committed yet (scheduleDrain is a microtask).
      expect(readCounter(sqlite)).toBe(0);

      await writer.drain();

      expect(readCounter(sqlite)).toBe(10);
    } finally {
      sqlite.close();
    }
  });

  test("drain() re-arms when new tasks arrive during the wait", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const writer = new DbWriter(db, { maxBatchSize: 2 });

      // Enqueue a slow task that itself enqueues another task.
      let secondEnqueued = false;
      void writer.enqueue(async (tx) => {
        await tx.run(sql`UPDATE counter SET value = value + 1 WHERE id = 1`);
        if (!secondEnqueued) {
          secondEnqueued = true;
          void writer.enqueue(async (tx2) => {
            await tx2.run(sql`UPDATE counter SET value = value + 10 WHERE id = 1`);
          });
        }
      });

      await writer.drain();

      // Both increments must be visible: drain() should wait for the
      // nested enqueue's task to also commit, not just the first batch.
      expect(readCounter(sqlite)).toBe(11);
    } finally {
      sqlite.close();
    }
  });

  test("drain() supports concurrent awaiters", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const writer = new DbWriter(db, { maxBatchSize: 4 });

      for (let i = 0; i < 5; i++) {
        void writer.enqueue(async (tx) => {
          await tx.run(sql`UPDATE counter SET value = value + 1 WHERE id = 1`);
        });
      }

      await Promise.all([writer.drain(), writer.drain(), writer.drain()]);

      expect(readCounter(sqlite)).toBe(5);
    } finally {
      sqlite.close();
    }
  });

  test("task rejection does not stall drain()", async () => {
    const { sqlite, db } = createTestDb();
    try {
      const writer = new DbWriter(db, { maxBatchSize: 2 });

      // First task rejects the entire batch — second task in the batch will
      // also be rejected because they share a transaction.
      const failing = writer.enqueue(async () => {
        throw new Error("boom");
      });

      await expect(failing).rejects.toThrow("boom");

      // Subsequent good tasks should still drain normally.
      void writer.enqueue(async (tx) => {
        await tx.run(sql`UPDATE counter SET value = value + 1 WHERE id = 1`);
      });

      await writer.drain();

      expect(readCounter(sqlite)).toBe(1);
    } finally {
      sqlite.close();
    }
  });
});
