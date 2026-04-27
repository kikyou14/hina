import { describe, expect, it } from "bun:test";
import { WsUpgradeRateLimiter } from "./ws-upgrade";

describe("WsUpgradeRateLimiter", () => {
  it("allows requests within the limit", () => {
    const limiter = new WsUpgradeRateLimiter({ limit: 3, windowMs: 60_000, sweepIntervalMs: 0 });
    const now = 1000;
    expect(limiter.check("1.2.3.4", now)).toBe(true);
    expect(limiter.check("1.2.3.4", now + 1)).toBe(true);
    expect(limiter.check("1.2.3.4", now + 2)).toBe(true);
    limiter.stop();
  });

  it("rejects requests exceeding the limit", () => {
    const limiter = new WsUpgradeRateLimiter({ limit: 2, windowMs: 60_000, sweepIntervalMs: 0 });
    const now = 1000;
    expect(limiter.check("1.2.3.4", now)).toBe(true);
    expect(limiter.check("1.2.3.4", now + 1)).toBe(true);
    expect(limiter.check("1.2.3.4", now + 2)).toBe(false);
    limiter.stop();
  });

  it("resets after window expires", () => {
    const limiter = new WsUpgradeRateLimiter({ limit: 1, windowMs: 1000, sweepIntervalMs: 0 });
    const now = 1000;
    expect(limiter.check("1.2.3.4", now)).toBe(true);
    expect(limiter.check("1.2.3.4", now + 500)).toBe(false);
    // After the window elapses, a new window starts
    expect(limiter.check("1.2.3.4", now + 1000)).toBe(true);
    limiter.stop();
  });

  it("tracks IPs independently", () => {
    const limiter = new WsUpgradeRateLimiter({ limit: 1, windowMs: 60_000, sweepIntervalMs: 0 });
    const now = 1000;
    expect(limiter.check("1.2.3.4", now)).toBe(true);
    expect(limiter.check("1.2.3.4", now + 1)).toBe(false);
    expect(limiter.check("5.6.7.8", now + 2)).toBe(true);
    limiter.stop();
  });

  it("stop clears internal state", () => {
    const limiter = new WsUpgradeRateLimiter({ limit: 1, windowMs: 60_000, sweepIntervalMs: 0 });
    limiter.check("1.2.3.4", 1000);
    limiter.stop();
    limiter.stop();
  });
});
