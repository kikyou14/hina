import { describe, expect, test } from "bun:test";
import {
  createShutdown,
  type ShutdownClock,
  type ShutdownDeps,
  type ShutdownLogger,
  type ShutdownOptions,
} from "./shutdown";

type FakeTimer = {
  id: number;
  atMs: number;
  callback: () => void;
};

class FakeClock implements ShutdownClock {
  private nowMs = 0;
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();

  now = () => this.nowMs;

  setTimer = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++;
    this.timers.set(id, {
      id,
      atMs: this.nowMs + Math.max(0, delayMs),
      callback,
    });
    return id;
  };

  clearTimer = (timer: unknown) => {
    this.timers.delete(timer as number);
  };

  get timerCount() {
    return this.timers.size;
  }

  async advanceBy(ms: number) {
    const targetMs = this.nowMs + ms;
    let reachedTarget = false;

    while (true) {
      await flushMicrotasks();
      const next = [...this.timers.values()]
        .filter((timer) => timer.atMs <= targetMs)
        .sort((a, b) => a.atMs - b.atMs || a.id - b.id)[0];

      if (next) {
        this.nowMs = next.atMs;
        this.timers.delete(next.id);
        next.callback();
        continue;
      }
      if (!reachedTarget) {
        this.nowMs = targetMs;
        reachedTarget = true;
        continue;
      }
      break;
    }
  }
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(args?: {
  deps?: Partial<ShutdownDeps>;
  options?: Partial<Omit<ShutdownOptions, "clock">>;
}) {
  const clock = new FakeClock();
  const calls: string[] = [];
  const logs: Array<{ level: "log" | "warn" | "error"; args: unknown[] }> = [];
  const logger: ShutdownLogger = {
    log: (...values) => logs.push({ level: "log", args: values }),
    warn: (...values) => logs.push({ level: "warn", args: values }),
    error: (...values) => logs.push({ level: "error", args: values }),
  };
  const deps: ShutdownDeps = {
    quiesce: () => calls.push("quiesce"),
    stopServer: async () => {
      calls.push("stopServer");
    },
    getPendingServerActivity: () => ({ requests: 0, websockets: 1 }),
    drainRequests: async () => {
      calls.push("drainRequests");
    },
    stopHub: async () => {
      calls.push("stopHub");
    },
    stopWorkers: async () => {
      calls.push("stopWorkers");
    },
    closeMaintenance: async () => {
      calls.push("closeMaintenance");
    },
    closeDb: () => calls.push("closeDb"),
    exit: (code) => calls.push(`exit:${code}`),
    logger,
    ...args?.deps,
  };
  const options: ShutdownOptions = {
    serverStopTimeoutMs: 500,
    shutdownDeadlineMs: 8_000,
    dbCloseReserveMs: 250,
    ...args?.options,
    clock,
  };

  return {
    calls,
    clock,
    logs,
    shutdown: createShutdown(deps, options),
  };
}

function expectCalls(harness: Harness, expected: string[]) {
  expect(harness.calls).toEqual(expected);
}

describe("createShutdown", () => {
  test("stops resources, closes the database, and exits", async () => {
    const harness = makeHarness();

    await harness.shutdown("SIGTERM");

    expectCalls(harness, [
      "quiesce",
      "stopServer",
      "drainRequests",
      "stopHub",
      "stopWorkers",
      "closeMaintenance",
      "closeDb",
      "exit:0",
    ]);
    expect(harness.clock.timerCount).toBe(0);
  });

  test("continues cleanup when server.stop remains pending and upgrades the exit code", async () => {
    const harness = makeHarness({
      deps: {
        stopServer: () => {
          harness.calls.push("stopServer");
          return new Promise(() => {});
        },
      },
    });

    const firstShutdown = harness.shutdown("SIGINT");
    const secondShutdown = harness.shutdown("uncaughtException", 1);
    expect(secondShutdown).toBe(firstShutdown);
    await flushMicrotasks();
    await harness.clock.advanceBy(500);
    await Promise.all([firstShutdown, secondShutdown]);

    expectCalls(harness, [
      "quiesce",
      "stopServer",
      "drainRequests",
      "stopHub",
      "stopWorkers",
      "closeMaintenance",
      "closeDb",
      "exit:1",
    ]);
    expect(harness.logs).toContainEqual({
      level: "warn",
      args: ["server.stop timed out after 500ms; continuing shutdown"],
    });
    expect(harness.logs).toContainEqual({
      level: "warn",
      args: ["server still has pending activity: requests=0 websockets=1"],
    });
    expect(harness.clock.timerCount).toBe(0);
  });

  test("skips database close when cleanup times out and exits only once", async () => {
    const pending = () => new Promise<void>(() => {});
    const harness = makeHarness({
      deps: {
        stopHub: () => {
          harness.calls.push("stopHub");
          return pending();
        },
        stopWorkers: () => {
          harness.calls.push("stopWorkers");
          return pending();
        },
        closeMaintenance: () => {
          harness.calls.push("closeMaintenance");
          return pending();
        },
      },
      options: {
        shutdownDeadlineMs: 100,
        dbCloseReserveMs: 20,
      },
    });

    const shutdown = harness.shutdown("SIGTERM");
    await flushMicrotasks();
    await harness.clock.advanceBy(80);
    await shutdown;
    await harness.clock.advanceBy(20);

    expectCalls(harness, [
      "quiesce",
      "stopServer",
      "drainRequests",
      "stopHub",
      "stopWorkers",
      "closeMaintenance",
      "exit:0",
    ]);
    expect(harness.logs).toContainEqual({
      level: "warn",
      args: ["database close skipped because shutdown cleanup did not complete safely"],
    });
    expect(harness.clock.timerCount).toBe(0);
  });

  test("global deadline wins the timer race and exits only once", async () => {
    const harness = makeHarness({
      deps: {
        stopServer: () => {
          harness.calls.push("stopServer");
          return new Promise(() => {});
        },
      },
      options: {
        serverStopTimeoutMs: 100,
        shutdownDeadlineMs: 50,
        dbCloseReserveMs: 10,
      },
    });

    const shutdown = harness.shutdown("uncaughtException", 1);
    await flushMicrotasks();
    await harness.clock.advanceBy(50);

    expectCalls(harness, ["quiesce", "stopServer", "exit:1"]);
    expect(harness.logs).toContainEqual({
      level: "error",
      args: ["shutdown timed out after 50ms, forcing exit"],
    });

    await harness.clock.advanceBy(50);
    await shutdown;
    expect(harness.calls.filter((call) => call === "exit:1")).toHaveLength(1);
  });

  test("skips database close and exits when cleanup fails", async () => {
    const error = new Error("cleanup failed");
    const harness = makeHarness({
      deps: {
        stopHub: async () => {
          harness.calls.push("stopHub");
          throw error;
        },
      },
    });

    await harness.shutdown("SIGTERM");

    expectCalls(harness, [
      "quiesce",
      "stopServer",
      "drainRequests",
      "stopHub",
      "stopWorkers",
      "closeMaintenance",
      "exit:0",
    ]);
    expect(harness.logs).toContainEqual({
      level: "error",
      args: ["wsHub.stop failed", error],
    });
    expect(harness.logs).toContainEqual({
      level: "warn",
      args: ["database close skipped because shutdown cleanup did not complete safely"],
    });
  });
});
