export type Resolution = "auto" | "raw";

export type ChooseIntervalInput = {
  resolution: Resolution;
  fromMs: number;
  toMs: number;
  maxPoints: number;
  rawIntervalSec: number;
  availableIntervalsSec: readonly number[];
};

export type ChooseIntervalResult =
  | { ok: true; intervalSec: number; expectedPoints: number }
  | {
      ok: false;
      code: "too_many_points";
      expectedPoints: number;
      maxPoints: number;
      recommendedIntervalSec: number;
    };

function expectedPoints(fromMs: number, toMs: number, intervalSec: number): number {
  const spanMs = toMs - fromMs;
  return Math.ceil(spanMs / (intervalSec * 1000));
}

function sortIntervalsAsc(intervals: readonly number[]): number[] {
  return [...new Set(intervals)].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
}

export function chooseIntervalSec(input: ChooseIntervalInput): ChooseIntervalResult {
  const intervals = sortIntervalsAsc(input.availableIntervalsSec);
  if (intervals.length === 0) throw new Error("No intervals available");

  if (!(input.toMs > input.fromMs)) throw new Error("Invalid range");
  if (!Number.isFinite(input.maxPoints) || input.maxPoints <= 0)
    throw new Error("Invalid maxPoints");

  if (input.resolution === "raw") {
    const raw = input.rawIntervalSec;
    const rawPoints = expectedPoints(input.fromMs, input.toMs, raw);
    if (rawPoints <= input.maxPoints)
      return { ok: true, intervalSec: raw, expectedPoints: rawPoints };

    const autoPick =
      intervals.find((it) => expectedPoints(input.fromMs, input.toMs, it) <= input.maxPoints) ??
      intervals.at(-1)!;
    return {
      ok: false,
      code: "too_many_points",
      expectedPoints: rawPoints,
      maxPoints: input.maxPoints,
      recommendedIntervalSec: autoPick,
    };
  }

  for (const intervalSec of intervals) {
    const points = expectedPoints(input.fromMs, input.toMs, intervalSec);
    if (points <= input.maxPoints) return { ok: true, intervalSec, expectedPoints: points };
  }

  const largest = intervals.at(-1)!;
  const points = expectedPoints(input.fromMs, input.toMs, largest);
  return {
    ok: false,
    code: "too_many_points",
    expectedPoints: points,
    maxPoints: input.maxPoints,
    recommendedIntervalSec: largest,
  };
}
