import { describe, expect, test } from "bun:test";
import { Outbox, type OutboxSink } from "./outbox";

type SendMode = "ok" | "buffer" | "drop";

function makeSink() {
  const sent: string[] = [];
  let mode: SendMode = "ok";
  let corkDepth = 0;
  let maxCorkDepth = 0;
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  const sink: OutboxSink = {
    send(data: string) {
      if (mode === "ok") {
        sent.push(data);
        return data.length;
      }
      // "buffer" models Bun's -1 (frame accepted into the socket buffer, still
      // delivered later, drain will fire); "drop" models 0 (lost, no drain).
      return mode === "buffer" ? -1 : 0;
    },
    cork(fn: () => void) {
      corkDepth += 1;
      maxCorkDepth = Math.max(maxCorkDepth, corkDepth);
      try {
        return fn();
      } finally {
        corkDepth -= 1;
      }
    },
    close(code?: number, reason?: string) {
      closeCalls.push({ code, reason });
    },
  };
  return {
    sink,
    sent,
    setMode: (m: SendMode) => {
      mode = m;
    },
    corkCount: () => maxCorkDepth,
    closeCount: () => closeCalls.length,
    lastClose: () => closeCalls.at(-1),
  };
}

// Trip backpressure without polluting `sent`/`pending`: a single -1 frame flips
// the socket to backpressured (a -1 frame is delivered by Bun, never re-stored).
function tripBackpressure(box: Outbox, sink: OutboxSink, setMode: (m: SendMode) => void) {
  setMode("buffer");
  box.push(sink, "__trip__", "__trip__");
  setMode("buffer");
}

describe("Outbox", () => {
  test("sends immediately and stays clean while the socket is healthy", () => {
    const box = new Outbox();
    const { sink, sent } = makeSink();

    box.push(sink, "a1", "a:1");
    box.push(sink, "a2", "a:2");

    expect(sent).toEqual(["a1", "a2"]);
    expect(box.isBackpressured).toBe(false);
    expect(box.pendingSize).toBe(0);
    expect(box.pendingBytes).toBe(0);
  });

  test("a buffered frame (-1) trips backpressure but is not re-stored", () => {
    const box = new Outbox();
    const { sink, sent, setMode } = makeSink();

    setMode("buffer");
    box.push(sink, "first", "a:1");

    // -1 means the socket buffered it; it will still be delivered, so we must not
    // keep a duplicate. But we now treat the socket as backpressured.
    expect(box.isBackpressured).toBe(true);
    expect(box.pendingSize).toBe(0);
    expect(box.pendingBytes).toBe(0);
    expect(sent).toEqual([]);
  });

  test("coalesces to the latest frame per key while backpressured", () => {
    const box = new Outbox();
    const { sink, sent, setMode } = makeSink();

    tripBackpressure(box, sink, setMode);

    // Subsequent pushes are held and coalesced by key.
    box.push(sink, "a1-old", "a:1");
    box.push(sink, "a1-new", "a:1"); // overwrites a:1
    box.push(sink, "b1", "b:1");
    expect(box.pendingSize).toBe(2); // a:1 (latest) + b:1
    expect(box.pendingBytes).toBe(Buffer.byteLength("a1-newb1", "utf8"));

    // On drain the survivors flush with the newest value per key.
    setMode("ok");
    box.drain(sink);
    expect(sent).toEqual(["a1-new", "b1"]);
    expect(box.isBackpressured).toBe(false);
    expect(box.pendingSize).toBe(0);
    expect(box.pendingBytes).toBe(0);
  });

  test("closes and clears pending frames when the entry ceiling is exceeded", () => {
    const box = new Outbox({ maxPendingEntries: 2, maxPendingBytes: 1_000 });
    const { sink, setMode, closeCount, lastClose } = makeSink();

    tripBackpressure(box, sink, setMode);
    box.push(sink, "a", "a:1");
    box.push(sink, "b", "b:1");

    expect(box.pendingSize).toBe(2);
    expect(closeCount()).toBe(0);

    box.push(sink, "c", "c:1");

    expect(box.isClosed).toBe(true);
    expect(box.isBackpressured).toBe(false);
    expect(box.pendingSize).toBe(0);
    expect(box.pendingBytes).toBe(0);
    expect(closeCount()).toBe(1);
    expect(lastClose()).toEqual({ code: 1013, reason: "backpressure_limit" });
  });

  test("uses UTF-8 bytes and replacement accounting for the byte ceiling", () => {
    const box = new Outbox({ maxPendingEntries: 10, maxPendingBytes: 5 });
    const { sink, setMode, closeCount, lastClose } = makeSink();

    tripBackpressure(box, sink, setMode);
    box.push(sink, "éé", "a:1"); // 4 bytes
    box.push(sink, "é", "a:1"); // replacement shrinks the retained value to 2 bytes
    box.push(sink, "abc", "b:1"); // exactly reaches the 5-byte ceiling

    expect(box.pendingSize).toBe(2);
    expect(box.pendingBytes).toBe(5);
    expect(closeCount()).toBe(0);

    box.push(sink, "x", "c:1");

    expect(box.isClosed).toBe(true);
    expect(box.pendingSize).toBe(0);
    expect(box.pendingBytes).toBe(0);
    expect(closeCount()).toBe(1);
    expect(lastClose()).toEqual({ code: 1013, reason: "backpressure_limit" });
  });

  test("re-pushing a key replays it in real last-write order (not its original slot)", () => {
    const box = new Outbox();
    const { sink, sent, setMode } = makeSink();

    tripBackpressure(box, sink, setMode);

    // A telemetry frame, then a full agent upsert, then a NEWER telemetry frame —
    // the exact sequence that breaks the client if replayed out of order.
    box.push(sink, "tele-v1", "t:1");
    box.push(sink, "upsert", "a:1");
    box.push(sink, "tele-v2", "t:1"); // re-key: must move to the END

    setMode("ok");
    box.drain(sink);

    // Correct: upsert first, newest telemetry last, so the client applies the
    // freshest state last. A plain Map.set would keep t:1 in its original slot
    // and replay ["tele-v2", "upsert"], letting the older upsert clobber the
    // newer telemetry on the client.
    expect(sent).toEqual(["upsert", "tele-v2"]);
    expect(box.pendingSize).toBe(0);
  });

  test("a dropped frame (0) closes the socket instead of waiting for a drain", () => {
    const box = new Outbox();
    const { sink, sent, setMode, closeCount } = makeSink();

    setMode("drop");
    box.push(sink, "lost", "a:1");

    // 0 means the frame was dropped with no delivery and no guaranteed drain, so
    // the socket is closed rather than parked on a drain that may never fire.
    expect(closeCount()).toBe(1);
    expect(box.isClosed).toBe(true);
    expect(box.isBackpressured).toBe(false);
    expect(box.pendingSize).toBe(0);
    expect(box.pendingBytes).toBe(0);
    expect(sent).toEqual([]);
  });

  test("after close, further pushes and drains are no-ops", () => {
    const box = new Outbox();
    const { sink, sent, setMode, closeCount } = makeSink();

    setMode("drop");
    box.push(sink, "lost", "a:1"); // closes the socket
    expect(box.isClosed).toBe(true);

    // No more writes, no second close, no accumulation.
    setMode("ok");
    box.push(sink, "after", "a:1");
    box.drain(sink);
    expect(sent).toEqual([]);
    expect(box.pendingSize).toBe(0);
    expect(box.pendingBytes).toBe(0);
    expect(closeCount()).toBe(1);
  });

  test("drain that re-enters backpressure requeues the untried remainder", () => {
    const box = new Outbox();
    const { sink, sent, setMode } = makeSink();

    tripBackpressure(box, sink, setMode);
    box.push(sink, "a", "a:1");
    box.push(sink, "b", "b:1");
    box.push(sink, "c", "c:1");
    expect(box.pendingSize).toBe(3);

    // Socket accepts the first replayed frame then backpressures again.
    let calls = 0;
    const flaky: OutboxSink = {
      send(data: string) {
        calls += 1;
        if (calls === 1) {
          sent.push(data);
          return data.length;
        }
        return -1; // buffered; trips backpressure without re-storing
      },
      cork(fn) {
        return fn();
      },
      close() {},
    };
    box.drain(flaky);

    // First frame delivered; second was buffered (-1, not re-stored); third
    // untried and requeued.
    expect(sent).toEqual(["a"]);
    expect(box.isBackpressured).toBe(true);
    expect(box.pendingSize).toBe(1); // only "c" remains
    expect(box.pendingBytes).toBe(1);

    // A later drain with a healthy socket flushes the remainder.
    setMode("ok");
    box.drain(sink);
    expect(sent).toEqual(["a", "c"]);
    expect(box.pendingSize).toBe(0);
    expect(box.pendingBytes).toBe(0);
  });

  test("a dropped frame mid-drain closes the socket and abandons the remainder", () => {
    const box = new Outbox();
    const { sink, sent, setMode } = makeSink();

    tripBackpressure(box, sink, setMode);
    box.push(sink, "a", "a:1");
    box.push(sink, "b", "b:1");
    box.push(sink, "c", "c:1");

    let calls = 0;
    let closed = 0;
    const flaky: OutboxSink = {
      send(data: string) {
        calls += 1;
        if (calls === 1) {
          sent.push(data);
          return data.length;
        }
        return 0; // dropped mid-replay
      },
      cork(fn) {
        return fn();
      },
      close() {
        closed += 1;
      },
    };
    box.drain(flaky);

    // First frame delivered, second dropped → socket closed, remainder abandoned.
    expect(sent).toEqual(["a"]);
    expect(closed).toBe(1);
    expect(box.isClosed).toBe(true);
    expect(box.pendingSize).toBe(0);
    expect(box.pendingBytes).toBe(0);
  });

  test("drain uses cork to batch the replayed frames", () => {
    const box = new Outbox();
    const { sink, setMode, corkCount } = makeSink();

    tripBackpressure(box, sink, setMode);
    box.push(sink, "a", "a:1");
    box.push(sink, "b", "b:1");

    setMode("ok");
    box.drain(sink);
    expect(corkCount()).toBe(1);
  });
});
