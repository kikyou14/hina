import { isSignatureSubsequence, type RouteObservationQuality } from "./traceroute-route";

export type RouteState = {
  stableSignature: string | null;
  stableObservedAtMs: number | null;

  candidateSignature: string | null;
  candidateFirstSeenAtMs: number | null;
  candidateLastSeenAtMs: number | null;
  candidateSeenCount: number;
  candidateStrongSeenCount: number;

  lastObservationTsMs: number | null;
};

export type RouteObservationInput = {
  signature: string;
  quality: RouteObservationQuality;
  tsMs: number;
};

export type RouteChangePolicy = {
  confirmCount: number;
  confirmStrongCount: number;
  candidateExpireMs: number;
};

export type RouteChangeEmit = {
  prevSignature: string;
  signature: string;
};

export type AdvanceResult = {
  state: RouteState;
  emit: RouteChangeEmit | null;
};

const MIN_CANDIDATE_EXPIRE_MS = 15 * 60 * 1000; // 15 min
const MAX_CANDIDATE_EXPIRE_MS = 24 * 60 * 60 * 1000; // 24 h
const DEFAULT_CANDIDATE_EXPIRE_MS = 30 * 60 * 1000; // 30 min

export function buildRouteChangePolicy(taskIntervalSec: number | null): RouteChangePolicy {
  let candidateExpireMs = DEFAULT_CANDIDATE_EXPIRE_MS;
  if (taskIntervalSec !== null && taskIntervalSec > 0) {
    // Give the candidate 6 probe cycles to accumulate confirmations.
    candidateExpireMs = Math.max(
      MIN_CANDIDATE_EXPIRE_MS,
      Math.min(taskIntervalSec * 6_000, MAX_CANDIDATE_EXPIRE_MS),
    );
  }
  return {
    confirmCount: 2,
    confirmStrongCount: 1,
    candidateExpireMs,
  };
}

export function emptyRouteState(): RouteState {
  return {
    stableSignature: null,
    stableObservedAtMs: null,
    candidateSignature: null,
    candidateFirstSeenAtMs: null,
    candidateLastSeenAtMs: null,
    candidateSeenCount: 0,
    candidateStrongSeenCount: 0,
    lastObservationTsMs: null,
  };
}

export function advanceRouteChangeState(
  prev: RouteState,
  obs: RouteObservationInput,
  policy: RouteChangePolicy,
): AdvanceResult {
  if (obs.quality === "unusable") {
    return { state: prev, emit: null };
  }

  if (prev.lastObservationTsMs !== null && obs.tsMs < prev.lastObservationTsMs) {
    return { state: prev, emit: null };
  }

  const next: RouteState = { ...prev, lastObservationTsMs: obs.tsMs };

  if (next.stableSignature === null) {
    return handleNoBaseline(next, obs, policy);
  }

  if (
    obs.signature === next.stableSignature ||
    isSignatureSubsequence(obs.signature, next.stableSignature)
  ) {
    next.stableObservedAtMs = obs.tsMs;
    next.candidateSignature = null;
    next.candidateFirstSeenAtMs = null;
    next.candidateLastSeenAtMs = null;
    next.candidateSeenCount = 0;
    next.candidateStrongSeenCount = 0;
    return { state: next, emit: null };
  }

  return handleCandidate(next, obs, policy);
}

function handleNoBaseline(
  next: RouteState,
  obs: RouteObservationInput,
  policy: RouteChangePolicy,
): AdvanceResult {
  if (next.candidateSignature === null) {
    next.candidateSignature = obs.signature;
    next.candidateFirstSeenAtMs = obs.tsMs;
    next.candidateLastSeenAtMs = obs.tsMs;
    next.candidateSeenCount = 1;
    next.candidateStrongSeenCount = obs.quality === "strong" ? 1 : 0;
    return { state: next, emit: null };
  }

  if (
    obs.signature === next.candidateSignature ||
    isSignatureSubsequence(obs.signature, next.candidateSignature)
  ) {
    next.candidateSeenCount += 1;
    next.candidateStrongSeenCount += obs.quality === "strong" ? 1 : 0;
    next.candidateLastSeenAtMs = obs.tsMs;

    if (
      next.candidateSeenCount >= policy.confirmCount &&
      next.candidateStrongSeenCount >= policy.confirmStrongCount
    ) {
      next.stableSignature = next.candidateSignature;
      next.stableObservedAtMs = obs.tsMs;
      next.candidateSignature = null;
      next.candidateFirstSeenAtMs = null;
      next.candidateLastSeenAtMs = null;
      next.candidateSeenCount = 0;
      next.candidateStrongSeenCount = 0;
    }
    return { state: next, emit: null };
  }

  next.candidateSignature = obs.signature;
  next.candidateFirstSeenAtMs = obs.tsMs;
  next.candidateLastSeenAtMs = obs.tsMs;
  next.candidateSeenCount = 1;
  next.candidateStrongSeenCount = obs.quality === "strong" ? 1 : 0;
  return { state: next, emit: null };
}

function handleCandidate(
  next: RouteState,
  obs: RouteObservationInput,
  policy: RouteChangePolicy,
): AdvanceResult {
  if (
    next.candidateSignature !== null &&
    (obs.signature === next.candidateSignature ||
      isSignatureSubsequence(obs.signature, next.candidateSignature))
  ) {
    if (
      next.candidateFirstSeenAtMs !== null &&
      obs.tsMs - next.candidateFirstSeenAtMs > policy.candidateExpireMs
    ) {
      next.candidateFirstSeenAtMs = obs.tsMs;
      next.candidateLastSeenAtMs = obs.tsMs;
      next.candidateSeenCount = 1;
      next.candidateStrongSeenCount = obs.quality === "strong" ? 1 : 0;
      return { state: next, emit: null };
    }

    next.candidateSeenCount += 1;
    next.candidateStrongSeenCount += obs.quality === "strong" ? 1 : 0;
    next.candidateLastSeenAtMs = obs.tsMs;

    if (
      next.candidateSeenCount >= policy.confirmCount &&
      next.candidateStrongSeenCount >= policy.confirmStrongCount
    ) {
      const emit: RouteChangeEmit = {
        prevSignature: next.stableSignature!,
        signature: next.candidateSignature!,
      };
      next.stableSignature = next.candidateSignature;
      next.stableObservedAtMs = obs.tsMs;
      next.candidateSignature = null;
      next.candidateFirstSeenAtMs = null;
      next.candidateLastSeenAtMs = null;
      next.candidateSeenCount = 0;
      next.candidateStrongSeenCount = 0;
      return { state: next, emit };
    }

    return { state: next, emit: null };
  }

  next.candidateSignature = obs.signature;
  next.candidateFirstSeenAtMs = obs.tsMs;
  next.candidateLastSeenAtMs = obs.tsMs;
  next.candidateSeenCount = 1;
  next.candidateStrongSeenCount = obs.quality === "strong" ? 1 : 0;
  return { state: next, emit: null };
}
