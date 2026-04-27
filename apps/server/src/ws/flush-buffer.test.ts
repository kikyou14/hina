import { describe, expect, test } from "bun:test";
import type { AgentRegistry } from "../agents/registry";
import type { DbClient } from "../db/client";
import type { TelemetryIngestArgs } from "../ingest/telemetry";
import { type BufferedProbeResult, FlushBuffer, type FlushBufferDeps } from "./flush-buffer";

function makeControllableDb() {
  const pending: Array<() => void> = [];
  let callCount = 0;

  const db = {
    transaction: async (_fn: (tx: unknown) => Promise<unknown>) => {
      callCount++;
      // Intentionally skip invoking `_fn` — the test only cares about the
      // `stop()` sequencing, not about running real ingest against a mock tx.
      await new Promise<void>((resolve) => {
        pending.push(resolve);
      });
    },
  } as unknown as DbClient;

  return {
    db,
    getCallCount: () => callCount,
    releaseNext: () => {
      const resolve = pending.shift();
      if (resolve) resolve();
    },
    pendingCount: () => pending.length,
  };
}

function makeFlakyDb() {
  let callCount = 0;
  let mode: "fail" | "noop" = "noop";

  const db = {
    transaction: async (_fn: (tx: unknown) => Promise<unknown>) => {
      callCount++;
      if (mode === "fail") throw new Error("simulated db failure");
    },
  } as unknown as DbClient;

  return {
    db,
    getCallCount: () => callCount,
    setMode: (m: "fail" | "noop") => {
      mode = m;
    },
  };
}

function fakeTelemetry(agentId: string, seq = 1): TelemetryIngestArgs {
  return {
    agentId,
    recvTsMs: 1000,
    seq,
    uptimeSec: null,
    rxBytesTotal: 0,
    txBytesTotal: 0,
    latestTelemetryPack: Buffer.alloc(0),
    numericMetrics: {},
  };
}

function fakeProbe(agentId: string, bytes = 1): BufferedProbeResult {
  return {
    bytes,
    args: {
      agentId,
      recvTsMs: 1000,
      result: { tid: "task-1", ts: 1000, ok: true },
    },
    isTraceroute: false,
  };
}

const stubRegistry = {
  applyTelemetryTraffic: () => {},
  applyTelemetryLatest: () => {},
  drainPendingPeriodRefreshes: async () => {},
  hasPendingPeriodRefreshes: () => false,
  has: () => true,
} as unknown as AgentRegistry;

function makeDeps(db: DbClient): FlushBufferDeps {
  return {
    db,
    registry: stubRegistry,
    asnLookup: null,
    isAgentConnected: () => true,
    onRouteChanges: () => {},
  };
}

async function waitUntil(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

describe("FlushBuffer", () => {
  test("stop() is a no-op when buffers are empty", async () => {
    const { db, getCallCount } = makeControllableDb();
    const buffer = new FlushBuffer(makeDeps(db), {
      maxProbeEntries: 100,
      maxProbeBytes: 1024,
      flushIntervalMs: 1000,
    });
    await buffer.stop();
    expect(getCallCount()).toBe(0);
  });

  test("stop() flushes buffered telemetry on shutdown", async () => {
    const { db, getCallCount, releaseNext } = makeControllableDb();
    const buffer = new FlushBuffer(makeDeps(db), {
      maxProbeEntries: 100,
      maxProbeBytes: 1024,
      flushIntervalMs: 10_000, // interval effectively disabled
    });

    buffer.enqueueTelemetry(fakeTelemetry("agent-A"));
    const stopPromise = buffer.stop();

    // stop() should call transaction once for the final flush.
    await waitUntil(() => getCallCount() === 1);
    releaseNext();
    await stopPromise;

    expect(getCallCount()).toBe(1);
  });

  test("stop() awaits in-flight flush and then drains data enqueued during it", async () => {
    const { db, getCallCount, releaseNext, pendingCount } = makeControllableDb();
    const buffer = new FlushBuffer(makeDeps(db), {
      maxProbeEntries: 100,
      maxProbeBytes: 1024,
      flushIntervalMs: 5, // fast interval so the first flush fires quickly
    });

    // (1) Enqueue A and start the interval so a flush is scheduled shortly.
    buffer.enqueueTelemetry(fakeTelemetry("agent-A"));
    buffer.start();

    // (2) Wait until the in-flight flush has entered db.transaction.
    await waitUntil(() => getCallCount() === 1);
    expect(pendingCount()).toBe(1);

    // (3) Enqueue B while the in-flight flush is still hanging — it lands
    //     in a fresh buffer that has NOT been snapshotted yet.
    buffer.enqueueTelemetry(fakeTelemetry("agent-B"));

    // (4) Kick off stop() concurrently with the in-flight flush.
    const stopPromise = buffer.stop();

    // Give stop() a tick to reach its `while (this.inflight)` wait.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    // The stop() call must not have started a second transaction yet —
    // it should be waiting for the in-flight one to release.
    expect(getCallCount()).toBe(1);

    // (5) Release the in-flight flush. stop() should now wake up and start
    //     a final flush for B.
    releaseNext();

    // (6) Wait for the final flush's transaction to start, then release it.
    await waitUntil(() => getCallCount() === 2);
    releaseNext();

    await stopPromise;

    // Exactly two transactions: one for A (the in-flight), one for B (the
    // final flush triggered by stop).
    expect(getCallCount()).toBe(2);
  });

  test("stop() clears the interval so no further flushes are scheduled", async () => {
    const { db, getCallCount, releaseNext } = makeControllableDb();
    const buffer = new FlushBuffer(makeDeps(db), {
      maxProbeEntries: 100,
      maxProbeBytes: 1024,
      flushIntervalMs: 5,
    });

    buffer.enqueueTelemetry(fakeTelemetry("agent-A"));
    buffer.start();

    // Let the first flush run.
    await waitUntil(() => getCallCount() === 1);

    const stopPromise = buffer.stop();
    releaseNext(); // release the in-flight flush so stop can proceed
    await stopPromise;

    const countAfterStop = getCallCount();

    // Wait well past the interval window to confirm nothing new fires.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(getCallCount()).toBe(countAfterStop);
  });

  test("start() after stop() does not restart the interval", async () => {
    const { db, getCallCount } = makeControllableDb();
    const buffer = new FlushBuffer(makeDeps(db), {
      maxProbeEntries: 100,
      maxProbeBytes: 1024,
      flushIntervalMs: 5,
    });
    await buffer.stop();

    buffer.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(getCallCount()).toBe(0);
  });

  test("transaction failure re-enqueues telemetry for the next flush", async () => {
    const { db, getCallCount, setMode } = makeFlakyDb();
    const buffer = new FlushBuffer(makeDeps(db), {
      maxProbeEntries: 100,
      maxProbeBytes: 1024,
      flushIntervalMs: 5,
    });

    buffer.enqueueTelemetry(fakeTelemetry("agent-A"));
    setMode("fail");
    buffer.start();

    // First tick fails. The data must remain queued so a follow-up tick will
    // retry it — verified indirectly by a second transaction call after we
    // flip the mock to succeed.
    await waitUntil(() => getCallCount() === 1);

    setMode("noop");
    await waitUntil(() => getCallCount() === 2);

    await buffer.stop();
  });

  test("transaction failure re-enqueues probe results for the next flush", async () => {
    const { db, getCallCount, setMode } = makeFlakyDb();
    const buffer = new FlushBuffer(makeDeps(db), {
      maxProbeEntries: 100,
      maxProbeBytes: 1024,
      flushIntervalMs: 5,
    });

    expect(buffer.enqueueProbeResult(fakeProbe("agent-A", 50))).toBe(true);
    setMode("fail");
    buffer.start();

    await waitUntil(() => getCallCount() === 1);

    setMode("noop");
    await waitUntil(() => getCallCount() === 2);

    await buffer.stop();
  });

  test("drops the retry batch after maxConsecutiveFailures", async () => {
    const { db, getCallCount, setMode } = makeFlakyDb();
    const buffer = new FlushBuffer(makeDeps(db), {
      maxProbeEntries: 100,
      maxProbeBytes: 1024,
      flushIntervalMs: 5,
      maxConsecutiveFailures: 2,
    });

    buffer.enqueueTelemetry(fakeTelemetry("agent-A"));
    expect(buffer.enqueueProbeResult(fakeProbe("agent-A", 50))).toBe(true);
    setMode("fail");
    buffer.start();

    // Two failed ticks — after the second the batch is dropped to break out
    // of head-of-line poisoning.
    await waitUntil(() => getCallCount() === 2);

    // Switching to a passing mode must NOT produce a third transaction call:
    // the buffer is empty after the drop, so flush() short-circuits.
    setMode("noop");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(getCallCount()).toBe(2);

    await buffer.stop();
  });

  test("a successful flush resets the consecutive failure counter", async () => {
    const { db, getCallCount, setMode } = makeFlakyDb();
    const buffer = new FlushBuffer(makeDeps(db), {
      maxProbeEntries: 100,
      maxProbeBytes: 1024,
      flushIntervalMs: 5,
      maxConsecutiveFailures: 2,
    });

    // Cycle 1: fail then succeed — the success must zero the counter.
    buffer.enqueueTelemetry(fakeTelemetry("agent-A", 1));
    setMode("fail");
    buffer.start();
    await waitUntil(() => getCallCount() === 1);

    setMode("noop");
    await waitUntil(() => getCallCount() === 2);

    // Cycle 2: another single fail must not trigger the drop branch (it
    // would if the counter had been carried over from cycle 1). With reset,
    // the eventual success bumps the call count to 4.
    buffer.enqueueTelemetry(fakeTelemetry("agent-A", 2));
    setMode("fail");
    await waitUntil(() => getCallCount() === 3);

    setMode("noop");
    await waitUntil(() => getCallCount() === 4);

    await buffer.stop();
  });
});
