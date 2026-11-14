/**
 * The maths behind the Performance tab: latency, verbosity, cost and payback
 * over the loaded comparison records. Kept apart from the view so it can be
 * checked against exported records without a browser.
 *
 * A request has one record per candidate. The primary's numbers repeat in each
 * of them, so primary statistics count each request once; candidate statistics
 * count each comparison. A candidate that errored has no latency, tokens or
 * cost worth plotting, so those records are left out of the candidate's
 * distributions and counted separately.
 */
import { wilsonLowerBound } from "../lib/stats";
import { modelId } from "./backend";
import { candidateKey, counts, median } from "./records";
import type { ShadowRecord, Summary, Verdict } from "./shadowClient";

export type Role = "primary" | "candidate";

export interface Series {
  key: string;
  role: Role;
  /** Model name as shown. */
  model: string;
  /** provider/model */
  id: string;
  experiment?: string;
  /** Colour slot: primaries take 0, candidates 1, 2, … in scorecard order. */
  slot: number;
}

export type Outcome = "pass" | "fail" | "error" | "unscored";

/** A finite number, or undefined for anything missing or malformed. */
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const positive = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
};
const nonNegative = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
};

export const primaryKey = (r: Pick<ShadowRecord, "primary">) => `primary|${modelId(r.primary)}`;

export function outcomeOf(r: ShadowRecord): Outcome {
  if (r.candidate_error) return "error";
  if (!counts(r)) return "unscored";
  return r.pass ? "pass" : "fail";
}

// ---------- order statistics ----------

/** Nearest-rank percentile of ascending values, as the gateway computes its p50 and p95. `p` is 0 to 1. */
export function quantile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export interface Spread {
  n: number;
  min: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function spread(sorted: number[]): Spread | undefined {
  if (sorted.length === 0) return undefined;
  const q = (p: number) => quantile(sorted, p)!;
  let sum = 0;
  for (const v of sorted) sum += v;
  return {
    n: sorted.length,
    min: sorted[0],
    p5: q(0.05),
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    p90: q(0.9),
    p95: q(0.95),
    p99: q(0.99),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

/** Share of ascending values at or below x. */
export function ecdfAt(sorted: number[], x: number): number {
  if (sorted.length === 0) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

/** Smallest sample size at which a percentile stops being one of the few slowest values. */
export const trustworthyAt = (p: number) => Math.ceil(10 / (1 - p));

// ---------- the model of the loaded records ----------

export interface Paired {
  /** Requests where both latencies were measured. */
  n: number;
  faster: number;
  slower: number;
  same: number;
  /** candidate − primary, ms, ascending. */
  diffs: number[];
}

export interface CandidateStats {
  key: string;
  comparisons: number;
  errors: number;
  /** Counted toward agreement, as on the scorecard: scored pairs plus errors. */
  evidence: number;
  passes: number;
  agreement?: number;
  lower?: number;
  /** Mean over completed comparisons. */
  avgCandidateCost?: number;
  /** Mean primary cost over the same comparisons, so the saving compares like with like. */
  avgPrimaryCost?: number;
  verdict?: Verdict;
}

export interface Perf {
  series: Series[];
  /** Distinct requests among the loaded records. */
  requests: number;
  comparisons: number;
  /** First and last time a request was recorded, ms since the epoch. */
  first?: number;
  last?: number;
  /** When each request was first recorded, ascending. */
  arrivals: number[];
  /** Ascending, per series key. */
  latency: Map<string, number[]>;
  outputTokens: Map<string, number[]>;
  cost: Map<string, number[]>;
  /** candidate output ÷ primary output per comparison, ascending, per candidate key. */
  tokenRatio: Map<string, number[]>;
  /** Sum of candidate and primary output tokens over the same comparisons, per candidate key. */
  tokenTotals: Map<string, { candidate: number; primary: number }>;
  paired: Map<string, Paired>;
  candidates: Map<string, CandidateStats>;
  /** Candidate errors, per candidate key. */
  errors: Map<string, number>;
  /** Comparisons with no usable latency besides errors (zero or missing), per series key. */
  unmeasured: Map<string, number>;
  /** What the loaded comparisons cost to run: candidate calls and judging. */
  spend: { candidate: number; judge: number };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const ascending = (a: number, b: number) => a - b;

export function analyse(records: ShadowRecord[], summary?: Summary): Perf {
  const latency = new Map<string, number[]>();
  const outputTokens = new Map<string, number[]>();
  const cost = new Map<string, number[]>();
  const tokenRatio = new Map<string, number[]>();
  const tokenTotals = new Map<string, { candidate: number; primary: number }>();
  const paired = new Map<string, Paired>();
  const errors = new Map<string, number>();
  const unmeasured = new Map<string, number>();
  const candidates = new Map<string, CandidateStats>();
  const costSums = new Map<string, { n: number; candidate: number; primary: number }>();
  const spend = { candidate: 0, judge: 0 };

  const primaries = new Map<string, Series>();
  const candidateSeries = new Map<string, Series>();
  /** request id → when it was first recorded */
  const seen = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

  for (const r of records) {
    const at = Date.parse(r.created_at);
    const pk = primaryKey(r);
    const ck = candidateKey(r);
    if (!primaries.has(pk)) primaries.set(pk, { key: pk, role: "primary", model: r.primary.model, id: modelId(r.primary), slot: 0 });
    if (!candidateSeries.has(ck))
      candidateSeries.set(ck, { key: ck, role: "candidate", model: r.candidate.model, id: modelId(r.candidate), experiment: r.experiment, slot: 0 });

    spend.candidate += nonNegative(r.candidate_cost_usd) ?? 0;
    spend.judge += nonNegative(r.eval_cost_usd) ?? 0;

    // The primary, once per request.
    const requestKey = `${r.request_id}|${pk}`;
    if (!seen.has(requestKey)) {
      seen.set(requestKey, Number.isFinite(at) ? at : NaN);
      const lat = positive(r.primary_latency_ms);
      if (lat !== undefined) push(latency, pk, lat);
      else bump(unmeasured, pk);
      const out = nonNegative(r.primary_output_tokens);
      if (out !== undefined) push(outputTokens, pk, out);
      const c = nonNegative(r.primary_cost_usd);
      if (c !== undefined) push(cost, pk, c);
    } else if (Number.isFinite(at)) {
      const prev = seen.get(requestKey)!;
      if (!Number.isFinite(prev) || at < prev) seen.set(requestKey, at);
    }

    // The candidate, once per comparison.
    const stats = candidates.get(ck) ?? { key: ck, comparisons: 0, errors: 0, evidence: 0, passes: 0 };
    candidates.set(ck, stats);
    stats.comparisons++;
    if (counts(r)) stats.evidence++;
    if (r.candidate_error) {
      stats.errors++;
      bump(errors, ck);
      continue;
    }
    if (counts(r) && r.pass) stats.passes++;

    const cLat = positive(r.candidate_latency_ms);
    const pLat = positive(r.primary_latency_ms);
    if (cLat !== undefined) push(latency, ck, cLat);
    else bump(unmeasured, ck);
    if (cLat !== undefined && pLat !== undefined) {
      const p = paired.get(ck) ?? { n: 0, faster: 0, slower: 0, same: 0, diffs: [] };
      paired.set(ck, p);
      const d = cLat - pLat;
      p.n++;
      p.diffs.push(d);
      if (d < 0) p.faster++;
      else if (d > 0) p.slower++;
      else p.same++;
    }

    const cOut = nonNegative(r.candidate_output_tokens);
    const pOut = nonNegative(r.primary_output_tokens);
    if (cOut !== undefined) push(outputTokens, ck, cOut);
    if (cOut !== undefined && pOut !== undefined) {
      if (pOut > 0) push(tokenRatio, ck, cOut / pOut);
      const t = tokenTotals.get(ck) ?? { candidate: 0, primary: 0 };
      t.candidate += cOut;
      t.primary += pOut;
      tokenTotals.set(ck, t);
    }

    const cCost = nonNegative(r.candidate_cost_usd);
    const pCost = nonNegative(r.primary_cost_usd);
    if (cCost !== undefined) push(cost, ck, cCost);
    if (cCost !== undefined && pCost !== undefined) {
      const acc = costSums.get(ck) ?? { n: 0, candidate: 0, primary: 0 };
      acc.n++;
      acc.candidate += cCost;
      acc.primary += pCost;
      costSums.set(ck, acc);
    }
  }

  for (const list of [latency, outputTokens, cost, tokenRatio]) for (const v of list.values()) v.sort(ascending);
  for (const p of paired.values()) p.diffs.sort(ascending);

  const verdicts = new Map((summary?.pairs ?? []).map((p) => [candidateKey(p), p.verdict] as const));
  for (const s of candidates.values()) {
    const acc = costSums.get(s.key);
    if (acc) {
      s.avgCandidateCost = acc.candidate / acc.n;
      s.avgPrimaryCost = acc.primary / acc.n;
    }
    if (s.evidence > 0) {
      s.agreement = s.passes / s.evidence;
      s.lower = wilsonLowerBound(s.passes, s.evidence);
    }
    s.verdict = verdicts.get(s.key);
  }

  // Colour follows the entity: candidates in the scorecard's order (experiment, then
  // provider/model), so a candidate keeps its colour as others come and go.
  const cands = [...candidateSeries.values()].sort((a, b) =>
    a.experiment === b.experiment ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.experiment ?? "") < (b.experiment ?? "") ? -1 : 1,
  );
  cands.forEach((s, i) => (s.slot = i + 1));
  // The same model in two experiments needs the experiment to tell them apart.
  for (const s of cands) if (cands.some((o) => o !== s && o.model === s.model)) s.model = `${s.model} (${s.experiment})`;
  const prims = [...primaries.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

  const arrivals = [...seen.values()].filter(Number.isFinite).sort(ascending);
  return {
    series: [...prims, ...cands],
    requests: seen.size,
    comparisons: records.length,
    first: arrivals[0],
    last: arrivals[arrivals.length - 1],
    arrivals,
    latency,
    outputTokens,
    cost,
    tokenRatio,
    tokenTotals,
    paired,
    candidates,
    errors,
    unmeasured,
    spend,
  };
}

// ---------- traffic rate and payback ----------

const DAY_MS = 86_400_000;

export interface Rate {
  /** Sampled requests among the loaded records. */
  requests: number;
  spanMs: number;
  /** Sampled requests a day at the observed pace. */
  sampledPerDay: number;
  /** All eligible requests ÷ sampled ones, from the gateway's counters or its sample rate. */
  scale: number;
  scaleFrom: "counters" | "sample_rate" | "none";
  /** Requests a day the source model serves, which a switch would make cheaper. */
  perDay: number;
  /** The same pace counting only the busy stretches, when long quiet gaps pull the average down. */
  activePerDay?: number;
  /** Total length of the quiet gaps. */
  quietMs: number;
}

/**
 * Requests a day at the pace the loaded records arrived, gaps included. Like the
 * gateway's own projection, a window shorter than a minute counts as a minute so
 * a burst of test traffic does not project an absurd volume.
 */
export function requestRate(perf: Perf, summary?: Summary): Rate | undefined {
  if (perf.requests < 2 || perf.first === undefined || perf.last === undefined) return undefined;
  const spanMs = perf.last - perf.first;
  const sampledPerDay = ((perf.requests - 1) / Math.max(spanMs, 60_000)) * DAY_MS;
  let scale = 1;
  let scaleFrom: Rate["scaleFrom"] = "none";
  const c = summary?.counters;
  if (c && c.sampled > 0 && c.eligible >= c.sampled) {
    scale = c.eligible / c.sampled;
    scaleFrom = "counters";
  } else if (summary && summary.sample_rate > 0 && summary.sample_rate < 1) {
    scale = 1 / summary.sample_rate;
    scaleFrom = "sample_rate";
  }
  // A gap is quiet when it is far longer than the usual wait between requests.
  const gaps: number[] = [];
  for (let i = 1; i < perf.arrivals.length; i++) gaps.push(perf.arrivals[i] - perf.arrivals[i - 1]);
  const typical = median(gaps) ?? 0;
  const quietOver = Math.max(15 * 60_000, 20 * typical);
  let busyMs = 0;
  let busyGaps = 0;
  let quietMs = 0;
  for (const g of gaps) {
    if (g > quietOver) quietMs += g;
    else {
      busyMs += g;
      busyGaps++;
    }
  }
  const activeSampled = busyGaps > 0 ? (busyGaps / Math.max(busyMs, 60_000)) * DAY_MS : undefined;
  const activePerDay = quietMs > 0 && activeSampled !== undefined && activeSampled > sampledPerDay * 1.5 ? activeSampled * scale : undefined;
  return { requests: perf.requests, spanMs, sampledPerDay, scale, scaleFrom, perDay: sampledPerDay * scale, activePerDay, quietMs };
}

export interface Payback {
  key: string;
  verdict?: Verdict;
  savingPerRequest: number;
  savingPerDay?: number;
  /** Days of switched traffic that repay what the loaded comparisons cost. */
  breakEvenDays?: number;
}

export function payback(perf: Perf, rate: Rate | undefined): Payback[] {
  const spent = perf.spend.candidate + perf.spend.judge;
  const out: Payback[] = [];
  for (const s of perf.candidates.values()) {
    if (s.avgPrimaryCost === undefined || s.avgCandidateCost === undefined) continue;
    const savingPerRequest = s.avgPrimaryCost - s.avgCandidateCost;
    const savingPerDay = rate ? savingPerRequest * rate.perDay : undefined;
    const breakEvenDays = savingPerDay !== undefined && savingPerDay > 0 ? spent / savingPerDay : undefined;
    out.push({ key: s.key, verdict: s.verdict, savingPerRequest, savingPerDay, breakEvenDays });
  }
  return out;
}

/**
 * The candidate a switch would go to: the ready one that saves the most per
 * request. Without a ready one, the most convincing candidate that would save
 * money, flagged as a what-if.
 */
export function bestCandidate(perf: Perf, paybacks: Payback[]): { payback: Payback; ready: boolean } | undefined {
  const saving = paybacks.filter((p) => p.savingPerRequest > 0);
  const ready = saving.filter((p) => p.verdict === "ready").sort((a, b) => b.savingPerRequest - a.savingPerRequest);
  if (ready.length) return { payback: ready[0], ready: true };
  const lower = (p: Payback) => perf.candidates.get(p.key)?.lower ?? 0;
  const rest = [...saving].sort((a, b) => lower(b) - lower(a) || b.savingPerRequest - a.savingPerRequest);
  return rest.length ? { payback: rest[0], ready: false } : undefined;
}

// ---------- traffic over time ----------

export interface Bucket {
  kind: "bucket";
  start: number;
  pass: number;
  fail: number;
  error: number;
  unscored: number;
}

/** A stretch with no comparisons at all, folded so the busy stretches keep their resolution. */
export interface Quiet {
  kind: "quiet";
  from: number;
  to: number;
}

export type Slot = Bucket | Quiet;

const STEPS = [
  10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, DAY_MS,
];

/** Slots a quiet stretch takes on the chart. */
export const QUIET_WIDTH = 3;
/** Empty buckets in a row before the stretch is folded. */
const FOLD_AFTER = 6;

/**
 * Comparisons per time bucket by outcome. Picks the smallest bucket that fits
 * `maxSlots`, folding any stretch of `FOLD_AFTER` or more empty buckets into one
 * quiet slot, so two bursts a day apart do not shrink to slivers at either end.
 */
export function traffic(records: ShadowRecord[], maxSlots: number): { step: number; slots: Slot[] } | undefined {
  const times = records
    .map((r) => Date.parse(r.created_at))
    .filter(Number.isFinite)
    .sort(ascending);
  if (times.length === 0) return undefined;
  // Align buckets to the local clock, so an hour bucket starts on the hour.
  const offset = -new Date(times[0]).getTimezoneOffset() * 60_000;
  const align = (t: number, step: number) => Math.floor((t + offset) / step) * step - offset;

  const layout = (step: number) => {
    const runs: { from: number; to: number }[] = [];
    for (const t of times) {
      const b = align(t, step);
      const run = runs[runs.length - 1];
      if (run && b - run.to <= FOLD_AFTER * step) run.to = b;
      else runs.push({ from: b, to: b });
    }
    const width = runs.reduce((n, r) => n + (r.to - r.from) / step + 1, 0) + (runs.length - 1) * QUIET_WIDTH;
    return { runs, width };
  };
  let step = STEPS[STEPS.length - 1];
  let runs = layout(step).runs;
  for (const s of STEPS) {
    const l = layout(s);
    if (l.width <= maxSlots) {
      step = s;
      runs = l.runs;
      break;
    }
  }

  const slots: Slot[] = [];
  const index = new Map<number, Bucket>();
  runs.forEach((run, i) => {
    if (i > 0) slots.push({ kind: "quiet", from: runs[i - 1].to + step, to: run.from });
    for (let t = run.from; t <= run.to; t += step) {
      const b: Bucket = { kind: "bucket", start: t, pass: 0, fail: 0, error: 0, unscored: 0 };
      slots.push(b);
      index.set(t, b);
    }
  });
  for (const r of records) {
    const at = Date.parse(r.created_at);
    if (!Number.isFinite(at)) continue;
    const b = index.get(align(at, step));
    if (b) b[outcomeOf(r)]++;
  }
  return { step, slots };
}

// ---------- scales and formats ----------

/** About `count` round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export const niceCeil = (v: number) => {
  if (v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * mag >= v) ?? 10) * mag;
};

/** Ticks for a log axis: decades, with 2 and 5 between them when the range is short. */
export function logTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  const mults = hi - lo <= 2 ? [1, 2, 5] : [1];
  const out: number[] = [];
  for (let e = lo; e <= hi; e++) for (const m of mults) {
    const v = m * 10 ** e;
    if (v >= min * 0.999 && v <= max * 1.001) out.push(Number(v.toPrecision(6)));
  }
  return out;
}

/** Dollars at a precision that suits the size: $1,234, $12.34, $0.0011. */
export function usd(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "–";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs === 0) return "$0";
  if (abs >= 1000) return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  if (abs < 1e-6) return `${sign}<$0.000001`;
  const digits = Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(abs))));
  return `${sign}$${abs.toFixed(digits)}`;
}

/** "about 7 minutes", "about 3 hours", "about 2 days". */
export function humanDays(days: number | undefined): string {
  if (days === undefined || !Number.isFinite(days)) return "never at this rate";
  const minutes = days * 1440;
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `about ${Math.round(minutes)} minute${Math.round(minutes) === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  if (hours < 36) return `about ${Math.round(hours)} hours`;
  if (days < 60) return `about ${Math.round(days)} days`;
  if (days < 730) return `about ${Math.round(days / 30)} months`;
  return "more than two years";
}

/** A span of time as "3 min 24 s", "21 h 30 min", "4 days". */
export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** A bucket size in words: "minute", "5 minutes", "hour". */
export function stepWords(step: number): string {
  if (step < 60_000) return `${step / 1000} seconds`;
  if (step === 60_000) return "minute";
  if (step < 3_600_000) return `${step / 60_000} minutes`;
  if (step === 3_600_000) return "hour";
  if (step < DAY_MS) return `${step / 3_600_000} hours`;
  return "day";
}

export const tokens = (v: number | undefined) => (v === undefined ? "–" : Math.round(v).toLocaleString("en-US"));
export const ratio = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? "–" : `${v >= 10 ? v.toFixed(0) : v.toFixed(2)}×`);
