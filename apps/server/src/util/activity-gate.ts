export class ActivityGate {
  private accepting = true;
  private activeCount = 0;
  private readonly idleWaiters = new Set<() => void>();

  tryEnter(): (() => void) | null {
    if (!this.accepting) return null;

    this.activeCount += 1;
    let active = true;

    return () => {
      if (!active) return;
      active = false;
      this.activeCount -= 1;

      if (this.activeCount !== 0) return;
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    };
  }

  quiesce(): void {
    this.accepting = false;
  }

  waitForIdle(): Promise<void> {
    if (this.activeCount === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }
}
