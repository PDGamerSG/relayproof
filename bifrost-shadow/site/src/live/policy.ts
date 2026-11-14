/**
 * Policy lab maths: decide the loaded comparisons again under thresholds other
 * than the gateway's, the way the plugin would (decidePass in
 * plugins/shadow/worker.go, summarize and verdictFor in plugins/shadow/store.go).
 * Only the judge's verdict can be re-decided from what a record keeps; every
 * other signal keeps the outcome it was given. Pure functions over ShadowRecord.
 */
import { pct, wilsonLowerBound, type Verdict } from "../lib/stats";
import { judgePasses } from "./judgeStats";
import { candidateKey } from "./records";
import type { ModelRef, ShadowRecord, Thresholds } from "./shadowClient";

export interface Policy {
  /** Bar for the 95% Wilson lower bound of agreement. */
  minAgreement: number;
  /** Counted comparisons before any verdict. */
  minSamples: number;
  /** Largest share of candidate calls that may fail. */
  maxErrorRate: number;
  /** Judge points the candidate may trail the primary by and still pass. */
  qualityTolerance: number;
  /** Count unscored pairs as failures. The plugin has no such setting: it always leaves them out. */
  unscoredFail: boolean;
}

/** Ranges for the controls; a gateway value outside one widens it. */
export const LIMITS = {
  minAgreement: { min: 0.8, max: 0.995, step: 0.005 },
  minSamples: { min: 10, max: 300, step: 1 },
  maxErrorRate: { min: 0, max: 0.2, step: 0.005 },
  qualityTolerance: { min: 0, max: 3, step: 0.5 },
} as const;

/** Columns of the verdict map: min agreement 80% to 99.5% in half points. */
export const MAP_BARS: number[] = Array.from({ length: 40 }, (_, i) => (800 + i * 5) / 1000);
/** Rows of the verdict map: quality tolerance 0 to 3 judge points. */
export const MAP_TOLERANCES: number[] = [0, 0.5, 1, 1.5, 2, 2.5, 3];

export function policyFrom(t: Thresholds): Policy {
  return {
    minAgreement: t.min_agreement,
    minSamples: t.min_samples,
    maxErrorRate: t.max_error_rate,
    qualityTolerance: t.quality_tolerance,
    unscoredFail: false,
  };
}

export const samePolicy = (a: Policy, b: Policy) =>
  a.minAgreement === b.minAgreement &&
  a.minSamples === b.minSamples &&
  a.maxErrorRate === b.maxErrorRate &&
  a.qualityTolerance === b.qualityTolerance &&
  a.unscoredFail === b.unscoredFail;

/** A bar as a percentage, with a decimal only when it has one: 0.9 -> "90%", 0.905 -> "90.5%". */
export const barLabel = (v: number) => pct(v, Math.round(v * 1000) % 10 === 0 ? 0 : 1);

/** "excluded": counts toward neither agreement nor the sample minimum. */
export type Outcome = "pass" | "fail" | "error" | "excluded";

/** The outcome the gateway recorded. */
export function recorded(r: ShadowRecord): Outcome {
  if (r.candidate_error) return "error";
  if (r.pass_basis === "unscored") return "excluded";
  return r.pass ? "pass" : "fail";
}

/**
 * The outcome under `p`. A candidate error stays an error; the tool and JSON
 * gates and tool arguments without a judge stay failures; a judge verdict is
 * decided again from its scores with the policy's tolerance; exact match,
 * embeddings and token overlap keep the outcome they were given; an unscored
 * pair stays out unless the policy counts it as a failure.
 */
export function decide(r: ShadowRecord, p: Policy): Outcome {
  if (r.candidate_error) return "error";
  switch (r.pass_basis) {
    case "tool_selection":
    case "json_schema":
    case "tool_arguments":
      return "fail";
    case "judge":
      if (r.judge) return judgePasses(r.judge, p.qualityTolerance) ? "pass" : "fail";
      break;
    case "unscored":
      return p.unscoredFail ? "fail" : "excluded";
  }
  return r.pass ? "pass" : "fail";
}

export interface Tally {
  /** Every comparison, unscored ones included; the error rate is over these, as in the plugin. */
  samples: number;
  /** Passes, failures and candidate errors: the evidence. */
  counted: number;
  passes: number;
  errors: number;
  excluded: number;
  judged: number;
  judgeErrors: number;
}

export function tally(records: ShadowRecord[], outcome: (r: ShadowRecord) => Outcome): Tally {
  const t: Tally = { samples: 0, counted: 0, passes: 0, errors: 0, excluded: 0, judged: 0, judgeErrors: 0 };
  for (const r of records) {
    t.samples++;
    if (!r.candidate_error) {
      if (r.judge) t.judged++;
      if (r.judge_error) t.judgeErrors++;
    }
    const o = outcome(r);
    if (o === "excluded") {
      t.excluded++;
      continue;
    }
    t.counted++;
    if (o === "pass") t.passes++;
    if (o === "error") t.errors++;
  }
  return t;
}

export interface Reading extends Tally {
  agreement: number;
  lowerBound: number;
  errorRate: number;
  judgeErrorRate: number;
  verdict: Verdict;
  reason: string;
}

/** The verdict for a tally, in the plugin's order: sample minimum, error rate, judge error rate, lower bound, point estimate. */
export function readTally(t: Tally, p: Policy, maxJudgeErrorRate: number): Reading {
  const agreement = t.counted > 0 ? t.passes / t.counted : 0;
  const lowerBound = wilsonLowerBound(t.passes, t.counted);
  const errorRate = t.samples > 0 ? t.errors / t.samples : 0;
  const attempts = t.judged + t.judgeErrors;
  const judgeErrorRate = attempts > 0 ? t.judgeErrors / attempts : 0;
  const bar = barLabel(p.minAgreement);
  let verdict: Verdict;
  let reason: string;
  if (t.counted < p.minSamples) {
    verdict = "collecting";
    reason = `${t.counted} of the ${p.minSamples} counted comparisons a verdict needs.`;
  } else if (errorRate > p.maxErrorRate) {
    verdict = "not_ready";
    reason = `${pct(errorRate)} of candidate calls failed, more than the ${pct(p.maxErrorRate)} allowed.`;
  } else if (judgeErrorRate > maxJudgeErrorRate) {
    verdict = "not_ready";
    reason = `The judge failed on ${pct(judgeErrorRate)} of its calls, more than the gateway's ${pct(maxJudgeErrorRate)} limit; a failing evaluator cannot vouch for anything.`;
  } else if (lowerBound >= p.minAgreement) {
    verdict = "ready";
    reason = `The lower bound, ${pct(lowerBound)}, clears the ${bar} bar.`;
  } else if (agreement >= p.minAgreement) {
    verdict = "promising";
    reason = `Agreement, ${pct(agreement)}, clears ${bar}, but its lower bound, ${pct(lowerBound)}, does not yet.`;
  } else {
    verdict = "not_ready";
    reason = `Agreement, ${pct(agreement)}, is below the ${bar} bar.`;
  }
  return { ...t, agreement, lowerBound, errorRate, judgeErrorRate, verdict, reason };
}

export interface Flip {
  record: ShadowRecord;
  from: Outcome;
  to: Outcome;
}

export interface CandidateLab {
  key: string;
  experiment: string;
  candidate: ModelRef;
  /** This candidate's loaded comparisons, oldest first. */
  records: ShadowRecord[];
  /** Comparisons the judge decided: the only ones the tolerance can move. */
  judgeDecided: number;
  /** Judge points each judge-decided pair trails the primary by (negative when the candidate scored higher). */
  deficits: number[];
  /** Under the gateway's policy, from the outcomes it recorded. */
  now: Reading;
  /** Under the simulated policy. */
  sim: Reading;
  /** Comparisons whose outcome differs between the two, newest first. */
  flips: Flip[];
  /** Comparisons whose recorded outcome the gateway's current tolerance would not give (decided under an older setting). */
  stale: number;
  /** Verdict per tolerance (rows, as MAP_TOLERANCES) and bar (columns, as MAP_BARS), other settings as simulated. */
  map: Verdict[][];
}

export function lab(records: ShadowRecord[], key: string, candidate: ModelRef, experiment: string, gateway: Policy, sim: Policy, maxJudgeErrorRate: number): CandidateLab {
  const mine = records.filter((r) => candidateKey(r) === key);
  const judge = mine.filter((r) => !r.candidate_error && r.pass_basis === "judge" && r.judge);
  const flips: Flip[] = [];
  let stale = 0;
  for (const r of mine) {
    const from = recorded(r);
    const to = decide(r, sim);
    if (from !== to) flips.push({ record: r, from, to });
    if (decide(r, gateway) !== from) stale++;
  }
  flips.sort((a, b) => Date.parse(b.record.created_at) - Date.parse(a.record.created_at));
  const map = MAP_TOLERANCES.map((tol) => {
    const t = tally(mine, (r) => decide(r, { ...sim, qualityTolerance: tol }));
    return MAP_BARS.map((bar) => readTally(t, { ...sim, minAgreement: bar }, maxJudgeErrorRate).verdict);
  });
  return {
    key,
    experiment,
    candidate,
    records: mine,
    judgeDecided: judge.length,
    deficits: judge.map((r) => r.judge!.primary_score - r.judge!.candidate_score),
    now: readTally(tally(mine, recorded), gateway, maxJudgeErrorRate),
    sim: readTally(tally(mine, (r) => decide(r, sim)), sim, maxJudgeErrorRate),
    flips,
    stale,
    map,
  };
}

/** One lab per candidate: in scorecard order when `pairs` is given, then any others the records name. */
export function labAll(
  records: ShadowRecord[],
  pairs: { experiment: string; candidate: ModelRef }[] | undefined,
  gateway: Policy,
  sim: Policy,
  maxJudgeErrorRate: number,
): CandidateLab[] {
  const seen = new Map<string, { experiment: string; candidate: ModelRef }>();
  for (const p of pairs ?? []) seen.set(candidateKey(p), p);
  for (const r of records) if (!seen.has(candidateKey(r))) seen.set(candidateKey(r), r);
  return [...seen]
    .map(([key, p]) => lab(records, key, p.candidate, p.experiment, gateway, sim, maxJudgeErrorRate))
    .filter((l) => l.records.length > 0);
}

/**
 * Counted comparisons needed in all for the 95% lower bound to reach `target`
 * if agreement stays at `rate`; undefined when it never does (rate at or below
 * the target) or not within `cap`.
 */
export function comparisonsAtRate(rate: number, target: number, cap = 1_000_000): number | undefined {
  if (!(rate > target)) return undefined;
  const clears = (n: number) => wilsonLowerBound(rate * n, n) >= target;
  if (!clears(cap)) return undefined;
  let lo = 1;
  let hi = cap;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (clears(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Largest bar the candidate is ready at, row by row of the map; undefined when it is ready at none. */
export function highestReadyBar(row: Verdict[]): number | undefined {
  let best: number | undefined;
  row.forEach((v, i) => {
    if (v === "ready") best = MAP_BARS[i];
  });
  return best;
}

/**
 * The thresholds block for the plugin config, with the plugin's own field names
 * and order. Fields the lab does not change keep the gateway's values.
 */
export function thresholdsSnippet(p: Policy, t: Thresholds): string {
  const r = (v: number) => Number(v.toFixed(4));
  return JSON.stringify(
    {
      thresholds: {
        min_samples: p.minSamples,
        min_agreement: r(p.minAgreement),
        max_error_rate: r(p.maxErrorRate),
        quality_tolerance: r(p.qualityTolerance),
        lexical_threshold: r(t.lexical_threshold),
        semantic_threshold: r(t.semantic_threshold),
        max_judge_error_rate: r(t.max_judge_error_rate),
      },
    },
    null,
    2,
  );
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  pass: "passes",
  fail: "fails",
  error: "candidate error",
  excluded: "not counted",
};
