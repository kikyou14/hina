type StopResult =
  | { status: "fulfilled" }
  | { status: "rejected"; reason: unknown }
  | { status: "timed_out" };

export type ShutdownClock = {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (timer: unknown) => void;
};

export type ShutdownLogger = Pick<Console, "log" | "warn" | "error">;

export type ShutdownDeps = {
  quiesce: () => void;
  stopServer: () => Promise<unknown>;
  getPendingServerActivity: () => { requests: number; websockets: number };
  drainRequests: () => Promise<unknown>;
  stopHub: () => Promise<unknown>;
  stopWorkers: () => Promise<unknown>;
  closeMaintenance: () => Promise<unknown>;
  closeDb: () => void;
  exit: (exitCode: number) => void;
  logger: ShutdownLogger;
};

export type ShutdownOptions = {
  serverStopTimeoutMs: number;
  shutdownDeadlineMs: number;
  dbCloseReserveMs: number;
  clock?: ShutdownClock;
};

const systemClock: ShutdownClock = {
  now: Date.now,
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function settleWithin(
  stop: () => Promise<unknown>,
  timeoutMs: number,
  clock: ShutdownClock,
): Promise<StopResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = clock.setTimer(() => {
      if (settled) return;
      settled = true;
      resolve({ status: "timed_out" });
    }, timeoutMs);

    Promise.resolve()
      .then(stop)
      .then(
        () => {
          if (settled) return;
          settled = true;
          clock.clearTimer(timer);
          resolve({ status: "fulfilled" });
        },
        (reason: unknown) => {
          if (settled) return;
          settled = true;
          clock.clearTimer(timer);
          resolve({ status: "rejected", reason });
        },
      );
  });
}

async function stopWithin(
  label: string,
  stop: () => Promise<unknown>,
  timeoutMs: number,
  clock: ShutdownClock,
  logger: ShutdownLogger,
): Promise<StopResult["status"]> {
  const result = await settleWithin(stop, timeoutMs, clock);
  if (result.status === "timed_out") {
    logger.warn(`${label} timed out after ${timeoutMs}ms; continuing shutdown`);
  } else if (result.status === "rejected") {
    logger.error(`${label} failed`, result.reason);
  }
  return result.status;
}

export function createShutdown(deps: ShutdownDeps, options: ShutdownOptions) {
  const clock = options.clock ?? systemClock;
  let requestedExitCode = 0;
  let shutdownPromise: Promise<void> | null = null;

  async function runShutdown(signal: string): Promise<void> {
    deps.logger.log(`shutting down (${signal})...`);

    const deadlineAt = clock.now() + options.shutdownDeadlineMs;
    let dbClosed = false;
    let exited = false;
    let quiesced = false;
    let cleanupCompleted = false;

    const closeDbOnce = () => {
      if (dbClosed) return;
      dbClosed = true;
      try {
        deps.closeDb();
      } catch (err) {
        deps.logger.error("db.close failed", err);
      }
    };

    const exitOnce = () => {
      if (exited) return;
      exited = true;
      deps.exit(requestedExitCode);
    };

    const forceExitTimer = clock.setTimer(() => {
      deps.logger.error(`shutdown timed out after ${options.shutdownDeadlineMs}ms, forcing exit`);
      exitOnce();
    }, options.shutdownDeadlineMs);

    try {
      try {
        deps.quiesce();
        quiesced = true;
      } catch (err) {
        deps.logger.error("quiesce failed", err);
      }

      const serverStopStatus = await stopWithin(
        "server.stop",
        deps.stopServer,
        options.serverStopTimeoutMs,
        clock,
        deps.logger,
      );
      if (exited) return;

      if (serverStopStatus === "timed_out") {
        try {
          const pending = deps.getPendingServerActivity();
          deps.logger.warn(
            `server still has pending activity: requests=${pending.requests} websockets=${pending.websockets}`,
          );
        } catch (err) {
          deps.logger.error("getPendingServerActivity failed", err);
        }
      }

      const cleanupTimeoutMs = Math.max(0, deadlineAt - clock.now() - options.dbCloseReserveMs);
      const cleanupStatuses = await Promise.all([
        stopWithin("requests.drain", deps.drainRequests, cleanupTimeoutMs, clock, deps.logger),
        stopWithin("wsHub.stop", deps.stopHub, cleanupTimeoutMs, clock, deps.logger),
        stopWithin("workers.stop", deps.stopWorkers, cleanupTimeoutMs, clock, deps.logger),
        stopWithin(
          "dbMaintenance.close",
          deps.closeMaintenance,
          cleanupTimeoutMs,
          clock,
          deps.logger,
        ),
      ]);
      cleanupCompleted = cleanupStatuses.every((status) => status === "fulfilled");
    } catch (err) {
      deps.logger.error("shutdown failed", err);
    }

    if (exited) return;
    if (quiesced && cleanupCompleted && clock.now() < deadlineAt) {
      closeDbOnce();
    } else {
      deps.logger.warn("database close skipped because shutdown cleanup did not complete safely");
    }
    clock.clearTimer(forceExitTimer);
    exitOnce();
  }

  return function shutdown(signal: string, exitCode = 0): Promise<void> {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    shutdownPromise ??= runShutdown(signal);
    return shutdownPromise;
  };
}
