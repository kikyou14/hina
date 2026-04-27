export type StopIntervalTask = () => Promise<void>;

export type IntervalTaskOptions = {
  label: string;
  intervalMs: number;
  runOnStart?: boolean;
  tick: () => Promise<void>;
};

export function startIntervalTask(opts: IntervalTaskOptions): StopIntervalTask {
  let currentTick: Promise<void> | null = null;
  let stopped = false;

  const run = () => {
    if (stopped || currentTick) return;
    currentTick = (async () => {
      try {
        await opts.tick();
      } catch (err) {
        console.error(`${opts.label} tick failed`, err);
      }
    })().finally(() => {
      currentTick = null;
    });
  };

  if (opts.runOnStart !== false) run();
  const timer = setInterval(run, opts.intervalMs);

  return async () => {
    stopped = true;
    clearInterval(timer);
    if (currentTick) await currentTick;
  };
}
