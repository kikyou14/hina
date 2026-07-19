import { describe, expect, test } from "bun:test";
import { ActivityGate } from "./activity-gate";

describe("ActivityGate", () => {
  test("rejects new activity after quiescing and waits for existing activity", async () => {
    const gate = new ActivityGate();
    const releaseFirst = gate.tryEnter();
    const releaseSecond = gate.tryEnter();
    expect(releaseFirst).not.toBeNull();
    expect(releaseSecond).not.toBeNull();

    gate.quiesce();
    expect(gate.tryEnter()).toBeNull();

    let idle = false;
    const waitForIdle = gate.waitForIdle().then(() => {
      idle = true;
    });

    releaseFirst?.();
    expect(idle).toBe(false);

    releaseSecond?.();
    await waitForIdle;
    expect(idle).toBe(true);
  });

  test("release functions are idempotent", async () => {
    const gate = new ActivityGate();
    const release = gate.tryEnter();

    gate.quiesce();
    release?.();
    release?.();

    await expect(gate.waitForIdle()).resolves.toBeUndefined();
  });
});
