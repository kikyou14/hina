type WindowEntry = {
  count: number;
  windowStartMs: number;
};

export type WsUpgradeRateLimiterOptions = {
  windowMs: number;
  limit: number;
  sweepIntervalMs: number;
};

const DEFAULT_OPTIONS: WsUpgradeRateLimiterOptions = {
  windowMs: 60_000,
  limit: 10,
  sweepIntervalMs: 60_000,
};

export class WsUpgradeRateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly opts: WsUpgradeRateLimiterOptions;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts?: Partial<WsUpgradeRateLimiterOptions>) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };

    if (this.opts.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), this.opts.sweepIntervalMs);
      // Allow the process to exit without waiting for this timer.
      if (this.sweepTimer && "unref" in this.sweepTimer) {
        this.sweepTimer.unref();
      }
    }
  }

  check(ip: string, nowMs: number = Date.now()): boolean {
    const entry = this.windows.get(ip);

    if (!entry || nowMs - entry.windowStartMs >= this.opts.windowMs) {
      this.windows.set(ip, { count: 1, windowStartMs: nowMs });
      return true;
    }

    entry.count += 1;
    return entry.count <= this.opts.limit;
  }

  private sweep(): void {
    const nowMs = Date.now();
    for (const [ip, entry] of this.windows) {
      if (nowMs - entry.windowStartMs >= this.opts.windowMs) {
        this.windows.delete(ip);
      }
    }
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.windows.clear();
  }
}
