import { describe, expect, test } from "bun:test";
import {
  advanceRouteChangeState,
  buildRouteChangePolicy,
  emptyRouteState,
  type RouteChangePolicy,
  type RouteObservationInput,
  type RouteState,
} from "./route-change-state";

const BASE_TS = 1_700_000_000_000;

function defaultPolicy(): RouteChangePolicy {
  return { confirmCount: 2, confirmStrongCount: 1, candidateExpireMs: 30 * 60 * 1000 };
}

function strong(signature: string, tsMs: number): RouteObservationInput {
  return { signature, quality: "strong", tsMs };
}

function usable(signature: string, tsMs: number): RouteObservationInput {
  return { signature, quality: "usable", tsMs };
}

function unusable(signature: string, tsMs: number): RouteObservationInput {
  return { signature, quality: "unusable", tsMs };
}

function runSequence(
  observations: RouteObservationInput[],
  policy?: RouteChangePolicy,
  initial?: RouteState,
) {
  const p = policy ?? defaultPolicy();
  let state = initial ?? emptyRouteState();
  const emits: Array<{ prevSignature: string; signature: string }> = [];
  for (const obs of observations) {
    const result = advanceRouteChangeState(state, obs, p);
    state = result.state;
    if (result.emit) emits.push(result.emit);
  }
  return { state, emits };
}

describe("baseline establishment", () => {
  test("first two strong observations silently establish baseline", () => {
    const { state, emits } = runSequence([
      strong("749,4837,4134", BASE_TS),
      strong("749,4837,4134", BASE_TS + 60_000),
    ]);
    expect(emits).toHaveLength(0);
    expect(state.stableSignature).toBe("749,4837,4134");
    expect(state.candidateSignature).toBeNull();
  });

  test("single observation does not establish baseline", () => {
    const { state, emits } = runSequence([strong("749,4837,4134", BASE_TS)]);
    expect(emits).toHaveLength(0);
    expect(state.stableSignature).toBeNull();
    expect(state.candidateSignature).toBe("749,4837,4134");
  });

  test("two different observations do not establish baseline", () => {
    const { state, emits } = runSequence([
      strong("749,4837,4134", BASE_TS),
      strong("749,3356,4134", BASE_TS + 60_000),
    ]);
    expect(emits).toHaveLength(0);
    expect(state.stableSignature).toBeNull();
    // Second observation replaces candidate
    expect(state.candidateSignature).toBe("749,3356,4134");
    expect(state.candidateSeenCount).toBe(1);
  });
});

describe("AS10099/AS4837 flapping produces zero alerts", () => {
  test("alternating 10099/4837 after normalization → same signature, no alert", () => {
    // After normalization both become "749,4837,4134"
    // This test verifies the pipeline at the state machine level
    const sig = "749,4837,4134";
    const { emits } = runSequence([
      strong(sig, BASE_TS),
      strong(sig, BASE_TS + 60_000), // baseline established
      strong(sig, BASE_TS + 120_000), // same sig (was AS10099, normalized)
      strong(sig, BASE_TS + 180_000), // same sig (was AS4837)
      strong(sig, BASE_TS + 240_000), // same sig (was AS10099)
    ]);
    expect(emits).toHaveLength(0);
  });
});

describe("genuine route change", () => {
  test("confirmed change emits exactly one event", () => {
    const { state, emits } = runSequence([
      strong("749,4837,4134", BASE_TS),
      strong("749,4837,4134", BASE_TS + 60_000), // baseline
      strong("749,3356,4134", BASE_TS + 120_000), // candidate seen=1
      strong("749,3356,4134", BASE_TS + 180_000), // candidate confirmed → emit
    ]);
    expect(emits).toHaveLength(1);
    expect(emits[0]).toEqual({
      prevSignature: "749,4837,4134",
      signature: "749,3356,4134",
    });
    expect(state.stableSignature).toBe("749,3356,4134");
    expect(state.candidateSignature).toBeNull();
  });

  test("single anomaly then revert produces zero alerts", () => {
    const { emits } = runSequence([
      strong("749,4837,4134", BASE_TS),
      strong("749,4837,4134", BASE_TS + 60_000), // baseline
      strong("749,3356,4134", BASE_TS + 120_000), // candidate seen=1
      strong("749,4837,4134", BASE_TS + 180_000), // back to stable → candidate cleared
    ]);
    expect(emits).toHaveLength(0);
  });
});

describe("hop dropout handling", () => {
  test("stable subsequence observation does not start candidate", () => {
    const { state, emits } = runSequence([
      strong("749,4837,4134", BASE_TS),
      strong("749,4837,4134", BASE_TS + 60_000), // baseline
      strong("749,4134", BASE_TS + 120_000), // subsequence of stable → no candidate
    ]);
    expect(emits).toHaveLength(0);
    expect(state.stableSignature).toBe("749,4837,4134");
    expect(state.candidateSignature).toBeNull();
  });

  test("longer observation that is superset of stable does not start candidate", () => {
    const { state, emits } = runSequence([
      strong("749,4134", BASE_TS),
      strong("749,4134", BASE_TS + 60_000), // baseline
      strong("749,4837,4134", BASE_TS + 120_000), // stable is subsequence → no candidate
    ]);
    expect(emits).toHaveLength(0);
    expect(state.stableSignature).toBe("749,4134");
    expect(state.candidateSignature).toBeNull();
  });
});

describe("out-of-order samples", () => {
  test("older timestamp does not advance state", () => {
    const { state, emits } = runSequence([
      strong("749,4837,4134", BASE_TS),
      strong("749,4837,4134", BASE_TS + 60_000), // baseline
      strong("749,3356,4134", BASE_TS - 10_000), // out of order → ignored
    ]);
    expect(emits).toHaveLength(0);
    expect(state.candidateSignature).toBeNull();
  });
});

describe("unusable observations", () => {
  test("unusable quality never advances state", () => {
    const { state, emits } = runSequence([
      strong("749,4837,4134", BASE_TS),
      strong("749,4837,4134", BASE_TS + 60_000), // baseline
      unusable("749,3356,4134", BASE_TS + 120_000), // ignored
    ]);
    expect(emits).toHaveLength(0);
    expect(state.candidateSignature).toBeNull();
  });
});

describe("candidate expiry", () => {
  test("expired candidate restarts from count=1", () => {
    const policy = defaultPolicy(); // 30 min expiry
    const { state, emits } = runSequence(
      [
        strong("749,4837,4134", BASE_TS),
        strong("749,4837,4134", BASE_TS + 60_000), // baseline
        strong("749,3356,4134", BASE_TS + 120_000), // candidate seen=1
        // 31 minutes later — beyond 30 min expiry
        strong("749,3356,4134", BASE_TS + 120_000 + 31 * 60_000), // expired → restart count=1
      ],
      policy,
    );
    expect(emits).toHaveLength(0);
    expect(state.candidateSignature).toBe("749,3356,4134");
    expect(state.candidateSeenCount).toBe(1);
  });

  test("non-expired candidate accumulates normally", () => {
    const policy = defaultPolicy(); // 30 min expiry
    const { state, emits } = runSequence(
      [
        strong("749,4837,4134", BASE_TS),
        strong("749,4837,4134", BASE_TS + 60_000), // baseline
        strong("749,3356,4134", BASE_TS + 120_000), // candidate seen=1
        // 10 minutes later — within 30 min expiry
        strong("749,3356,4134", BASE_TS + 120_000 + 10 * 60_000), // confirmed → emit
      ],
      policy,
    );
    expect(emits).toHaveLength(1);
    expect(state.stableSignature).toBe("749,3356,4134");
  });
});

describe("candidate replacement", () => {
  test("third route replaces existing candidate", () => {
    const { state, emits } = runSequence([
      strong("749,4837,4134", BASE_TS),
      strong("749,4837,4134", BASE_TS + 60_000), // baseline
      strong("749,3356,4134", BASE_TS + 120_000), // candidate A
      strong("749,6939,4134", BASE_TS + 180_000), // replaces candidate with B
    ]);
    expect(emits).toHaveLength(0);
    expect(state.candidateSignature).toBe("749,6939,4134");
    expect(state.candidateSeenCount).toBe(1);
  });
});

describe("quality requirements", () => {
  test("two usable observations without any strong do not promote", () => {
    const { state, emits } = runSequence([
      strong("749,4837,4134", BASE_TS),
      strong("749,4837,4134", BASE_TS + 60_000), // baseline
      usable("749,3356,4134", BASE_TS + 120_000), // candidate seen=1, strong=0
      usable("749,3356,4134", BASE_TS + 180_000), // candidate seen=2, strong=0 — not enough
    ]);
    expect(emits).toHaveLength(0);
    expect(state.candidateSignature).toBe("749,3356,4134");
    expect(state.candidateSeenCount).toBe(2);
    expect(state.candidateStrongSeenCount).toBe(0);
  });

  test("one usable + one strong promotes", () => {
    const { state, emits } = runSequence([
      strong("749,4837,4134", BASE_TS),
      strong("749,4837,4134", BASE_TS + 60_000), // baseline
      usable("749,3356,4134", BASE_TS + 120_000), // candidate seen=1, strong=0
      strong("749,3356,4134", BASE_TS + 180_000), // candidate seen=2, strong=1 → emit
    ]);
    expect(emits).toHaveLength(1);
    expect(state.stableSignature).toBe("749,3356,4134");
  });
});

describe("buildRouteChangePolicy", () => {
  test("null interval uses default 30 min expiry", () => {
    const p = buildRouteChangePolicy(null);
    expect(p.candidateExpireMs).toBe(30 * 60 * 1000);
  });

  test("60s interval → 6 min (clamped to 15 min minimum)", () => {
    const p = buildRouteChangePolicy(60);
    expect(p.candidateExpireMs).toBe(15 * 60 * 1000);
  });

  test("300s interval → 30 min", () => {
    const p = buildRouteChangePolicy(300);
    expect(p.candidateExpireMs).toBe(30 * 60 * 1000);
  });

  test("86400s interval → clamped to 24h max", () => {
    const p = buildRouteChangePolicy(86400);
    expect(p.candidateExpireMs).toBe(24 * 60 * 60 * 1000);
  });
});
