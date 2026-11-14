/**
 * Drift: whether a candidate has moved lately. A candidate that cleared the bar
 * can get worse later (a provider update, a shift in what people ask), and a
 * running total over hundreds of comparisons is slow to show it. This sets the
 * newest window of counted comparisons against the window before it, with 95%
 * intervals, and calls a change only when the interval of the difference
 * leaves out zero. Pure functions over ShadowRecord.
 */
import { rateDifference, wilsonInterval, type Difference, type Interval } from "./judgeStats";
import { candidateKey, counts, median } from "./records";
import type { ModelRef, ShadowRecord } from "./shadowClient";

/** Comparisons per window when there are enough. */
export const DRIFT_WINDOW = 50;
/** Below this many comparisons per window a change is not judged. */
export const MIN_WINDOW = 20;

export type DriftStatus = "steady" | "worse" | "better" | "thin";

export interface DriftWindow {
  /** Counted comparisons in the window: scored pairs and candidate errors. */
  n: number;
  passes: number;
  errors: number;
  agreement: number;
  interval: Interval;
  errorRate: number;
  /** Candidate p50 latency over the answers in the window; candidate errors are left out. */
  p50?: number;
  /** Positions among the candidate's counted comparisons, from 1. */
  first: number;
  last: number;
  from: number;
  to: number;
}

export interface RollingPoint {
  /** Position among the counted comparisons, from 1. */
  n: number;
  at: number;
  agreement: number;
}

export interface Drift {
  key: string;
  experiment: string;
  candidate: ModelRef;
  /** Counted comparisons loaded for this candidate. */
  counted: number;
  /** Comparisons per window. */
  size: number;
  /** The windows are smaller than DRIFT_WINDOW because fewer comparisons are loaded. */
  shrunk: boolean;
  before?: DriftWindow;
  recent?: DriftWindow;
  /** Recent agreement minus earlier agreement, with its 95% interval. */
  change?: Difference;
  status: DriftStatus;
  /** Comparisons in each point of the rolling line. */
  rollWidth: number;
  rolling: RollingPoint[];
  /** When each counted comparison was made, oldest first; places rollout events on the line. */
  times: number[];
}

function windowOf(list: ShadowRecord[], start: number, end: number): DriftWindow {
  const slice = list.slice(start, end);
  let passes = 0;
  let errors = 0;
  const latencies: number[] = [];
  for (const r of slice) {
    if (r.candidate_error) errors++;
    else {
      if (r.pass) passes++;
      latencies.push(r.candidate_latency_ms);
    }
  }
  const n = slice.length;
  return {
    n,
    passes,
    errors,
    agreement: n > 0 ? passes / n : 0,
    interval: wilsonInterval(passes, n),
    errorRate: n > 0 ? errors / n : 0,
    p50: median(latencies),
    first: start + 1,
    last: end,
    from: Date.parse(slice[0].created_at),
    to: Date.parse(slice[slice.length - 1].created_at),
  };
}

/** Window size for `counted` comparisons: DRIFT_WINDOW each when there are two of them, else half of what there is. */
export function windowSize(counted: number, preferred = DRIFT_WINDOW): number {
  return counted >= 2 * preferred ? preferred : Math.floor(counted / 2);
}

/**
 * Drift for one candidate. `records` must be oldest first (as RecordsState
 * keeps them); only counted comparisons take part, as in the scorecard.
 */
export function driftFor(records: ShadowRecord[], key: string, candidate: ModelRef, experiment: string, preferred = DRIFT_WINDOW): Drift {
  const list = records.filter((r) => candidateKey(r) === key && counts(r));
  const counted = list.length;
  const size = windowSize(counted, preferred);
  const out: Drift = {
    key,
    experiment,
    candidate,
    counted,
    size,
    shrunk: size < preferred,
    status: "thin",
    rollWidth: 0,
    rolling: [],
    times: list.map((r) => Date.parse(r.created_at)),
  };
  if (size >= 1) {
    out.recent = windowOf(list, counted - size, counted);
    out.before = windowOf(list, counted - 2 * size, counted - size);
    out.change = rateDifference(out.recent.passes, out.recent.n, out.before.passes, out.before.n);
    if (size >= MIN_WINDOW && out.change) {
      out.status = out.change.high < 0 ? "worse" : out.change.low > 0 ? "better" : "steady";
    }
  }

  // The rolling line uses a shorter span than the windows, so a dip inside one still shows.
  const width = Math.max(5, Math.min(25, Math.round(size / 2)));
  if (counted >= width + 2) {
    out.rollWidth = width;
    let passes = 0;
    for (let i = 0; i < counted; i++) {
      const r = list[i];
      if (!r.candidate_error && r.pass) passes++;
      if (i >= width) {
        const old = list[i - width];
        if (!old.candidate_error && old.pass) passes--;
      }
      if (i >= width - 1) out.rolling.push({ n: i + 1, at: out.times[i], agreement: passes / width });
    }
  }
  return out;
}

/** Drift for every candidate: in scorecard order when `pairs` is given, else in the order records first name them. */
export function driftAll(
  records: ShadowRecord[],
  pairs?: { experiment: string; candidate: ModelRef }[],
  preferred = DRIFT_WINDOW,
): Drift[] {
  const seen = new Map<string, { experiment: string; candidate: ModelRef }>();
  for (const p of pairs ?? []) seen.set(candidateKey(p), p);
  for (const r of records) if (!seen.has(candidateKey(r))) seen.set(candidateKey(r), r);
  return [...seen].map(([key, p]) => driftFor(records, key, p.candidate, p.experiment, preferred)).filter((d) => d.counted > 0);
}
