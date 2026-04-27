import { describe, expect, test } from "bun:test";
import { advance, type AdvanceInput, type SubjectState } from "./subject-state";

const NOW = 1_000_000;

function input(overrides: Partial<AdvanceInput>): AdvanceInput {
  return {
    prev: null,
    cond: false,
    present: true,
    forMs: 0,
    recoverMs: 0,
    nowMs: NOW,
    ...overrides,
  };
}

function pending(pendingSinceMs: number | null): SubjectState {
  return { active: false, pendingSinceMs };
}

function active(activeSinceMs: number, recoverSinceMs: number | null = null): SubjectState {
  return { active: true, activeSinceMs, recoverSinceMs };
}

describe("not present", () => {
  test("prev=null → null, no transition", () => {
    const r = advance(input({ present: false, prev: null }));
    expect(r.next).toBeNull();
    expect(r.transition).toBeNull();
  });

  test("prev=pending → null, no transition", () => {
    const r = advance(input({ present: false, prev: pending(NOW - 5000) }));
    expect(r.next).toBeNull();
    expect(r.transition).toBeNull();
  });

  test("prev=active → null, reset transition", () => {
    const r = advance(input({ present: false, prev: active(NOW - 10000) }));
    expect(r.next).toBeNull();
    expect(r.transition).toEqual({ kind: "reset" });
  });

  test("prev=active+recovering → null, reset transition", () => {
    const r = advance(input({ present: false, prev: active(NOW - 10000, NOW - 2000) }));
    expect(r.next).toBeNull();
    expect(r.transition).toEqual({ kind: "reset" });
  });
});

describe("present, cond=true", () => {
  test("prev=null, forMs=0 → fire immediately", () => {
    const r = advance(input({ cond: true, forMs: 0 }));
    expect(r.next).toEqual(active(NOW));
    expect(r.transition).toEqual({ kind: "fire", firedAtMs: NOW });
  });

  test("prev=null, forMs=5000 → pending", () => {
    const r = advance(input({ cond: true, forMs: 5000 }));
    expect(r.next).toEqual(pending(NOW));
    expect(r.transition).toBeNull();
  });

  test("prev=pending, duration not met → stay pending", () => {
    const r = advance(input({ cond: true, forMs: 5000, prev: pending(NOW - 3000) }));
    expect(r.next).toEqual(pending(NOW - 3000));
    expect(r.transition).toBeNull();
  });

  test("prev=pending, duration met → fire", () => {
    const r = advance(input({ cond: true, forMs: 5000, prev: pending(NOW - 5000) }));
    expect(r.next).toEqual(active(NOW));
    expect(r.transition).toEqual({ kind: "fire", firedAtMs: NOW });
  });

  test("prev=pending, duration exceeded → fire", () => {
    const r = advance(input({ cond: true, forMs: 5000, prev: pending(NOW - 10000) }));
    expect(r.next).toEqual(active(NOW));
    expect(r.transition).toEqual({ kind: "fire", firedAtMs: NOW });
  });

  test("prev=active → stay active, clear recoverSinceMs", () => {
    const r = advance(input({ cond: true, prev: active(NOW - 30000, NOW - 1000) }));
    expect(r.next).toEqual(active(NOW - 30000, null));
    expect(r.transition).toBeNull();
  });

  test("prev=active (no recovery) → stay active", () => {
    const r = advance(input({ cond: true, prev: active(NOW - 30000) }));
    expect(r.next).toEqual(active(NOW - 30000, null));
    expect(r.transition).toBeNull();
  });
});

describe("present, cond=false", () => {
  test("prev=null → null, no transition", () => {
    const r = advance(input({ cond: false }));
    expect(r.next).toBeNull();
    expect(r.transition).toBeNull();
  });

  test("prev=pending → null (clears stale pending)", () => {
    const r = advance(input({ cond: false, prev: pending(NOW - 3000) }));
    expect(r.next).toBeNull();
    expect(r.transition).toBeNull();
  });

  test("prev=active, recoverMs=0 → recover immediately", () => {
    const r = advance(input({ cond: false, recoverMs: 0, prev: active(NOW - 10000) }));
    expect(r.next).toBeNull();
    expect(r.transition).toEqual({ kind: "recover", recoveredAtMs: NOW });
  });

  test("prev=active, recoverMs=5000, no prior recoverSince → start recovering", () => {
    const r = advance(input({ cond: false, recoverMs: 5000, prev: active(NOW - 10000) }));
    expect(r.next).toEqual(active(NOW - 10000, NOW));
    expect(r.transition).toBeNull();
  });

  test("prev=active, recoverMs=5000, recovering, not met → keep recovering", () => {
    const r = advance(
      input({ cond: false, recoverMs: 5000, prev: active(NOW - 10000, NOW - 2000) }),
    );
    expect(r.next).toEqual(active(NOW - 10000, NOW - 2000));
    expect(r.transition).toBeNull();
  });

  test("prev=active, recoverMs=5000, recovering, met → recover", () => {
    const r = advance(
      input({ cond: false, recoverMs: 5000, prev: active(NOW - 10000, NOW - 5000) }),
    );
    expect(r.next).toBeNull();
    expect(r.transition).toEqual({ kind: "recover", recoveredAtMs: NOW });
  });
});

describe("oscillation", () => {
  test("active → cond=false → cond=true cancels recoverSinceMs", () => {
    // Tick 1: cond=false starts recovery
    const r1 = advance(input({ cond: false, recoverMs: 10000, prev: active(NOW - 50000) }));
    expect(r1.next).toEqual(active(NOW - 50000, NOW));

    // Tick 2: cond flips back to true → recovery canceled
    const r2 = advance(input({ cond: true, recoverMs: 10000, prev: r1.next!, nowMs: NOW + 2000 }));
    expect(r2.next).toEqual(active(NOW - 50000, null));
    expect(r2.transition).toBeNull();
  });

  test("pending → cond=false → back to cond=true restarts pendingSinceMs", () => {
    // Tick 1: start pending
    const r1 = advance(input({ cond: true, forMs: 10000 }));
    expect(r1.next).toEqual(pending(NOW));

    // Tick 2: cond goes false → clears pending
    const r2 = advance(input({ cond: false, forMs: 10000, prev: r1.next!, nowMs: NOW + 2000 }));
    expect(r2.next).toBeNull();

    // Tick 3: cond goes true again → fresh pending
    const r3 = advance(input({ cond: true, forMs: 10000, prev: null, nowMs: NOW + 4000 }));
    expect(r3.next).toEqual(pending(NOW + 4000));
  });
});

describe("zero delays", () => {
  test("forMs=0, prev=null, cond=true → fire immediately", () => {
    const r = advance(input({ cond: true, forMs: 0 }));
    expect(r.transition).toEqual({ kind: "fire", firedAtMs: NOW });
  });

  test("recoverMs=0, prev=active, cond=false → recover immediately", () => {
    const r = advance(input({ cond: false, recoverMs: 0, prev: active(NOW - 1000) }));
    expect(r.transition).toEqual({ kind: "recover", recoveredAtMs: NOW });
  });

  test("full cycle: fire then recover in two ticks with zero delays", () => {
    const r1 = advance(input({ cond: true, forMs: 0, recoverMs: 0 }));
    expect(r1.transition).toEqual({ kind: "fire", firedAtMs: NOW });

    const r2 = advance(
      input({ cond: false, forMs: 0, recoverMs: 0, prev: r1.next!, nowMs: NOW + 10000 }),
    );
    expect(r2.transition).toEqual({ kind: "recover", recoveredAtMs: NOW + 10000 });
    expect(r2.next).toBeNull();
  });
});
