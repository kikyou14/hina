export type SubjectState =
  | { active: false; pendingSinceMs: number | null }
  | { active: true; activeSinceMs: number; recoverSinceMs: number | null };

export type AdvanceInput = {
  prev: SubjectState | null;
  cond: boolean;
  present: boolean;
  forMs: number;
  recoverMs: number;
  nowMs: number;
};

export type Transition =
  | { kind: "fire"; firedAtMs: number }
  | { kind: "recover"; recoveredAtMs: number }
  | { kind: "reset" }
  | null;

export type AdvanceResult = {
  next: SubjectState | null;
  transition: Transition;
};

export function advance(input: AdvanceInput): AdvanceResult {
  const { prev, cond, present, forMs, recoverMs, nowMs } = input;

  if (!present) {
    if (prev !== null && prev.active) {
      return { next: null, transition: { kind: "reset" } };
    }
    // Was pending or absent — just clear
    return { next: null, transition: null };
  }

  if (cond) {
    if (prev !== null && prev.active) {
      // Already active: stay active, clear any recovery timer
      return {
        next: { active: true, activeSinceMs: prev.activeSinceMs, recoverSinceMs: null },
        transition: null,
      };
    }

    // Not yet active — enter or continue pending
    const pendingSinceMs =
      prev !== null && !prev.active && prev.pendingSinceMs !== null ? prev.pendingSinceMs : nowMs;

    if (nowMs - pendingSinceMs >= forMs) {
      // Pending duration met → fire
      return {
        next: { active: true, activeSinceMs: nowMs, recoverSinceMs: null },
        transition: { kind: "fire", firedAtMs: nowMs },
      };
    }

    // Still pending
    return {
      next: { active: false, pendingSinceMs },
      transition: null,
    };
  }

  if (prev !== null && prev.active) {
    const recoverSinceMs = prev.recoverSinceMs ?? nowMs;

    if (nowMs - recoverSinceMs >= recoverMs) {
      // Recovery duration met → recovered
      return {
        next: null,
        transition: { kind: "recover", recoveredAtMs: nowMs },
      };
    }

    // Still recovering
    return {
      next: { active: true, activeSinceMs: prev.activeSinceMs, recoverSinceMs },
      transition: null,
    };
  }

  // Not active and condition is false — clear any stale pending
  return { next: null, transition: null };
}
