/**
 * The readiness maths the site demonstrates. Both functions follow the plugin:
 * wilsonLowerBound in plugins/shadow/compare.go and verdictFor in plugins/shadow/store.go.
 */

export type Verdict = "collecting" | "promising" | "ready" | "not_ready";

export interface Thresholds {
  minSamples: number;
  minAgreement: number;
  maxErrorRate: number;
}

/** Plugin defaults (docs/features/shadow-traffic.mdx, field reference). */
export const DEFAULT_THRESHOLDS: Thresholds = {
  minSamples: 20,
  minAgreement: 0.9,
  maxErrorRate: 0.05,
};

const Z_95 = 1.959963984540054;

/** Lower end of the 95% Wilson score interval for `successes` out of `n`. */
export function wilsonLowerBound(successes: number, n: number): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const denom = 1 + (Z_95 * Z_95) / n;
  const centre = p + (Z_95 * Z_95) / (2 * n);
  const margin = Z_95 * Math.sqrt((p * (1 - p) + (Z_95 * Z_95) / (4 * n)) / n);
  return Math.max(0, (centre - margin) / denom);
}

export interface Evidence {
  /** Comparisons that produced a pass or fail, plus candidate errors. */
  samples: number;
  passes: number;
  errors: number;
}

export interface Reading {
  agreement: number;
  lowerBound: number;
  errorRate: number;
  verdict: Verdict;
}

export function read(evidence: Evidence, t: Thresholds = DEFAULT_THRESHOLDS): Reading {
  const { samples, passes, errors } = evidence;
  const agreement = samples > 0 ? passes / samples : 0;
  const lowerBound = wilsonLowerBound(passes, samples);
  const errorRate = samples > 0 ? errors / samples : 0;

  let verdict: Verdict;
  if (samples < t.minSamples) verdict = "collecting";
  else if (errorRate > t.maxErrorRate) verdict = "not_ready";
  else if (lowerBound >= t.minAgreement) verdict = "ready";
  else if (agreement >= t.minAgreement) verdict = "promising";
  else verdict = "not_ready";

  return { agreement, lowerBound, errorRate, verdict };
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  collecting: "Collecting",
  promising: "Promising",
  ready: "Ready",
  not_ready: "Not ready",
};

/** 0.966 -> "96.6%". */
export function pct(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return "–";
  return `${(fraction * 100).toFixed(digits)}%`;
}
