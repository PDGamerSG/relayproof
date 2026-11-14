/**
 * How far to trust the LLM judge behind the scorecards: whether answer order or
 * length sways it, how its score gaps spread, how often it fails, whether it
 * shares a family with the models it judges, and how often a person agrees with
 * it beyond chance. Pure functions over ShadowRecord, shared by the judge check
 * and the report.
 */
import type { JudgeVerdict, ShadowRecord } from "./shadowClient";

/** Plugin default for thresholds.quality_tolerance (judge points the candidate may trail by). */
export const DEFAULT_TOLERANCE = 1;
/** Verdicts per answer order below which a position effect is not judged. */
export const MIN_PER_ARM = 30;

const Z_95 = 1.959963984540054;

export type Judged = ShadowRecord & { judge: JudgeVerdict };

export interface Interval {
  low: number;
  high: number;
}

/** A difference between two rates with its 95% interval. */
export interface Difference extends Interval {
  diff: number;
}

/** Records the judge scored. */
export const judgedRecords = (records: ShadowRecord[]): Judged[] => records.filter((r): r is Judged => r.judge !== undefined);

/** Candidate score minus primary score (scores run 1 to 10). */
export const scoreGap = (v: JudgeVerdict) => v.candidate_score - v.primary_score;

/** The plugin's judge rule: the candidate passes when it trails the primary by at most `tolerance` points. */
export const judgePasses = (v: JudgeVerdict, tolerance = DEFAULT_TOLERANCE) => v.candidate_score >= v.primary_score - tolerance;

export type Preference = "primary" | "same" | "candidate";

/** The judge's scores as three classes: a gap within the tolerance counts as about the same. */
export function judgePreference(v: JudgeVerdict, tolerance = DEFAULT_TOLERANCE): Preference {
  const gap = scoreGap(v);
  if (Math.abs(gap) <= tolerance) return "same";
  return gap > 0 ? "candidate" : "primary";
}

/** 95% Wilson score interval for `k` successes out of `n`. */
export function wilsonInterval(k: number, n: number): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  const p = k / n;
  const z2 = Z_95 * Z_95;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = Z_95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return { low: Math.max(0, (centre - margin) / denom), high: Math.min(1, (centre + margin) / denom) };
}

/** k1/n1 − k2/n2 with a 95% interval (Newcombe's hybrid score method, sound at small counts). */
export function rateDifference(k1: number, n1: number, k2: number, n2: number): Difference | undefined {
  if (n1 <= 0 || n2 <= 0) return undefined;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const a = wilsonInterval(k1, n1);
  const b = wilsonInterval(k2, n2);
  const diff = p1 - p2;
  return {
    diff,
    low: diff - Math.sqrt((p1 - a.low) ** 2 + (b.high - p2) ** 2),
    high: diff + Math.sqrt((a.high - p1) ** 2 + (p2 - b.low) ** 2),
  };
}

/** True when a 95% interval leaves out zero. */
export const excludesZero = (i: Interval) => i.low > 0 || i.high < 0;

// ---------- position ----------

export interface PositionArm {
  n: number;
  /** The judge preferred the candidate. */
  wins: number;
  ties: number;
  /** The judge preferred the primary. */
  losses: number;
  /** Passed on the judge's scores. */
  passes: number;
}

export interface PositionBias {
  /** The candidate's answer was in the first slot. */
  first: PositionArm;
  second: PositionArm;
  /** Candidate win rate when shown first minus when shown second. */
  winGap?: Difference;
  /** Candidate loss rate when shown first minus when shown second. */
  lossGap?: Difference;
  /** Verdicts that named a winner. */
  decisive: number;
  /**
   * Share of those won by the answer in the first slot, averaged over the two
   * orders so an uneven split cannot fake a preference. 0.5 means none.
   */
  firstSlotShare?: number;
  firstSlotInterval?: Interval;
  /** Both orders have at least MIN_PER_ARM verdicts. */
  enough: boolean;
  /** Enough verdicts, and the win or loss gap's 95% interval leaves out zero. */
  flagged: boolean;
  /** Flagged, and the clear gap is at least 10 points. */
  large: boolean;
  /** Which slot the judge leans toward, when flagged. */
  favours?: "first" | "second";
}

const emptyArm = (): PositionArm => ({ n: 0, wins: 0, ties: 0, losses: 0, passes: 0 });

/** Candidate wins, ties and losses by the slot the candidate was shown in, with the gap between the two orders. */
export function positionBias(records: ShadowRecord[], tolerance = DEFAULT_TOLERANCE, minPerArm = MIN_PER_ARM): PositionBias {
  const first = emptyArm();
  const second = emptyArm();
  for (const r of judgedRecords(records)) {
    const arm = r.judge.candidate_shown_first ? first : second;
    arm.n++;
    if (r.judge.winner === "candidate") arm.wins++;
    else if (r.judge.winner === "primary") arm.losses++;
    else arm.ties++;
    if (judgePasses(r.judge, tolerance)) arm.passes++;
  }
  const winGap = rateDifference(first.wins, first.n, second.wins, second.n);
  const lossGap = rateDifference(first.losses, first.n, second.losses, second.n);

  // First slot wins: the candidate winning from slot one, or the primary winning from slot one.
  const d1 = first.wins + first.losses;
  const d2 = second.wins + second.losses;
  let firstSlotShare: number | undefined;
  let firstSlotInterval: Interval | undefined;
  if (d1 > 0 && d2 > 0) {
    const a1 = first.wins / d1;
    const a2 = second.losses / d2;
    firstSlotShare = (a1 + a2) / 2;
    const se = Math.sqrt((a1 * (1 - a1)) / d1 + (a2 * (1 - a2)) / d2) / 2;
    firstSlotInterval = { low: Math.max(0, firstSlotShare - Z_95 * se), high: Math.min(1, firstSlotShare + Z_95 * se) };
  }

  const enough = first.n >= minPerArm && second.n >= minPerArm;
  const winClear = winGap !== undefined && excludesZero(winGap);
  const lossClear = lossGap !== undefined && excludesZero(lossGap);
  const flagged = enough && (winClear || lossClear);
  let favours: PositionBias["favours"];
  let large = false;
  if (flagged) {
    large = (winClear && Math.abs(winGap!.diff) >= 0.1) || (lossClear && Math.abs(lossGap!.diff) >= 0.1);
    // Winning more, or losing less, from the first slot both point at it.
    const lean = (winClear ? winGap!.diff : 0) - (lossClear ? lossGap!.diff : 0);
    favours = lean > 0 ? "first" : lean < 0 ? "second" : undefined;
  }
  return { first, second, winGap, lossGap, decisive: d1 + d2, firstSlotShare, firstSlotInterval, enough, flagged, large, favours };
}

// ---------- length ----------

export interface LengthBucket {
  id: "much_shorter" | "shorter" | "similar" | "longer";
  label: string;
  /** Range of comparison.length_ratio (candidate characters / primary characters). */
  range: string;
  n: number;
  passes: number;
  passRate?: number;
  /** Mean of candidate score minus primary score. */
  meanGap?: number;
}

export interface Verbosity {
  buckets: LengthBucket[];
  /** Judged pairs with a length ratio. */
  measured: number;
  /** Judged pairs without one: the primary gave no text (tool-call turns) or answers were not stored. */
  skipped: number;
  /** Pearson correlation between log length ratio and score gap, with a 95% interval (Fisher z). */
  correlation?: { r: number; low: number; high: number; n: number };
}

const BUCKETS: { id: LengthBucket["id"]; label: string; range: string; test: (x: number) => boolean }[] = [
  { id: "much_shorter", label: "Much shorter", range: "under 0.5×", test: (x) => x < 0.5 },
  { id: "shorter", label: "Shorter", range: "0.5 to 0.8×", test: (x) => x >= 0.5 && x < 0.8 },
  { id: "similar", label: "About the same", range: "0.8 to 1.25×", test: (x) => x >= 0.8 && x <= 1.25 },
  { id: "longer", label: "Longer", range: "over 1.25×", test: (x) => x > 1.25 },
];

/** comparison.length_ratio when it means something: the plugin writes 0 when the primary has no text. */
export function lengthRatio(r: ShadowRecord): number | undefined {
  const x = r.comparison?.length_ratio;
  if (x === undefined || !Number.isFinite(x) || x < 0) return undefined;
  if (x > 0) return x;
  // 0 is a real ratio only when the primary said something and the candidate said nothing.
  return r.primary_answer?.text ? 0 : undefined;
}

/** Pearson correlation of two equal-length series, undefined when either is constant. */
export function pearson(xs: number[], ys: number[]): number | undefined {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return undefined;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return undefined;
  return sxy / Math.sqrt(sxx * syy);
}

/** Judge pass rate and mean score gap by how long the candidate's answer is relative to the primary's. */
export function verbosity(records: ShadowRecord[], tolerance = DEFAULT_TOLERANCE): Verbosity {
  const buckets: LengthBucket[] = BUCKETS.map((b) => ({ id: b.id, label: b.label, range: b.range, n: 0, passes: 0 }));
  const sums = buckets.map(() => 0);
  const logs: number[] = [];
  const gaps: number[] = [];
  let measured = 0;
  let skipped = 0;
  for (const r of judgedRecords(records)) {
    const x = lengthRatio(r);
    if (x === undefined) {
      skipped++;
      continue;
    }
    measured++;
    const i = BUCKETS.findIndex((b) => b.test(x));
    const gap = scoreGap(r.judge);
    buckets[i].n++;
    sums[i] += gap;
    if (judgePasses(r.judge, tolerance)) buckets[i].passes++;
    if (x > 0) {
      logs.push(Math.log2(x));
      gaps.push(gap);
    }
  }
  buckets.forEach((b, i) => {
    if (b.n > 0) {
      b.passRate = b.passes / b.n;
      b.meanGap = sums[i] / b.n;
    }
  });
  let correlation: Verbosity["correlation"];
  const r = pearson(logs, gaps);
  if (r !== undefined && logs.length > 3) {
    const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)));
    const se = 1 / Math.sqrt(logs.length - 3);
    correlation = { r, low: Math.tanh(z - Z_95 * se), high: Math.tanh(z + Z_95 * se), n: logs.length };
  }
  return { buckets, measured, skipped, correlation };
}

// ---------- score gaps ----------

export interface ScoreGaps {
  /** One bin per whole-point gap from −9 to +9 (candidate minus primary). */
  bins: { gap: number; n: number }[];
  n: number;
  /** Pairs given equal scores. */
  ties: number;
  tieRate?: number;
  /** Pairs at or above −tolerance, which pass on the judge. */
  passes: number;
  passRate?: number;
  meanGap?: number;
  tolerance: number;
}

/** Histogram of candidate minus primary score, with the tie rate and the share that clears the tolerance. */
export function scoreGaps(records: ShadowRecord[], tolerance = DEFAULT_TOLERANCE): ScoreGaps {
  const bins = Array.from({ length: 19 }, (_, i) => ({ gap: i - 9, n: 0 }));
  let n = 0;
  let ties = 0;
  let passes = 0;
  let sum = 0;
  for (const r of judgedRecords(records)) {
    const gap = scoreGap(r.judge);
    if (!Number.isFinite(gap)) continue;
    n++;
    sum += gap;
    if (gap === 0) ties++;
    if (judgePasses(r.judge, tolerance)) passes++;
    bins[Math.max(-9, Math.min(9, Math.round(gap))) + 9].n++;
  }
  return {
    bins,
    n,
    ties,
    tieRate: n > 0 ? ties / n : undefined,
    passes,
    passRate: n > 0 ? passes / n : undefined,
    meanGap: n > 0 ? sum / n : undefined,
    tolerance,
  };
}

// ---------- judge health ----------

export interface JudgeHealth {
  /** Judge calls that returned a verdict or failed. */
  attempts: number;
  errors: number;
  /** errors / attempts, as the scorecard computes judge_error_rate. */
  rate?: number;
  /** Up to three distinct recent error messages, newest first. */
  messages: string[];
  /** Verdicts that named as winner the answer their own scores ranked lower. */
  contradictions: number;
  judged: number;
}

/** Failed judge calls among all judge attempts, and verdicts that contradict their own scores. */
export function judgeHealth(records: ShadowRecord[]): JudgeHealth {
  let attempts = 0;
  let errors = 0;
  let judged = 0;
  let contradictions = 0;
  const messages: string[] = [];
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.judge) {
      attempts++;
      judged++;
      const gap = scoreGap(r.judge);
      if ((r.judge.winner === "candidate" && gap < 0) || (r.judge.winner === "primary" && gap > 0)) contradictions++;
    } else if (r.judge_error) {
      attempts++;
      errors++;
      if (messages.length < 3 && !messages.includes(r.judge_error)) messages.push(r.judge_error);
    }
  }
  return { attempts, errors, rate: attempts > 0 ? errors / attempts : undefined, messages, contradictions, judged };
}

// ---------- model family ----------

const FAMILIES: [RegExp, string][] = [
  [/claude/, "Anthropic Claude"],
  [/(^|[./-])(gpt|chatgpt|o[1-9])([-.]|$)|davinci|text-embedding/, "OpenAI GPT"],
  [/gemini|gemma|palm/, "Google Gemini"],
  [/llama/, "Meta Llama"],
  [/mistral|mixtral|codestral|ministral|magistral|pixtral/, "Mistral"],
  [/command|aya/, "Cohere Command"],
  [/deepseek/, "DeepSeek"],
  [/qwen|qwq/, "Alibaba Qwen"],
  [/grok/, "xAI Grok"],
  [/(^|[./-])phi-/, "Microsoft Phi"],
];

/** Providers that make their own models; hosts such as bedrock or openrouter say nothing about the family. */
const MAKERS: Record<string, string> = {
  anthropic: "Anthropic Claude",
  openai: "OpenAI GPT",
  gemini: "Google Gemini",
  google: "Google Gemini",
  mistral: "Mistral",
  cohere: "Cohere Command",
  xai: "xAI Grok",
  deepseek: "DeepSeek",
};

const modelPart = (id: string) => id.slice(id.lastIndexOf("/") + 1).toLowerCase();

/** The model family of a "provider/model" id: by model name first, then by provider. */
export function modelFamily(id: string): string | undefined {
  const name = modelPart(id);
  for (const [re, family] of FAMILIES) if (re.test(name)) return family;
  const slash = id.indexOf("/");
  return slash > 0 ? MAKERS[id.slice(0, slash).toLowerCase()] : undefined;
}

export interface FamilyLink {
  model: string;
  role: "primary" | "candidate";
  relation: "same model" | "same family";
}

/** Models the judge shares a family with, or is, among the primaries and candidates it scores. */
export function judgeFamilyLinks(judgeModel: string | undefined, models: { model: string; role: FamilyLink["role"] }[]): FamilyLink[] {
  if (!judgeModel) return [];
  const family = modelFamily(judgeModel);
  const seen = new Set<string>();
  const out: FamilyLink[] = [];
  for (const m of models) {
    const key = `${m.role}|${m.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (modelPart(m.model) === modelPart(judgeModel)) out.push({ ...m, relation: "same model" });
    else if (family && modelFamily(m.model) === family) out.push({ ...m, relation: "same family" });
  }
  return out;
}

// ---------- agreement ----------

export interface Kappa {
  n: number;
  /** Share of pairs where the two raters gave the same label. */
  agreement?: number;
  /** Agreement expected by chance from each rater's label frequencies. */
  chance?: number;
  /** (agreement − chance) / (1 − chance); undefined when chance is 1. */
  kappa?: number;
  /** Approximate 95% interval for kappa (Cohen 1960 standard error). */
  low?: number;
  high?: number;
  /** Distinct labels each rater used; kappa cannot leave 0 while either used one. */
  levels?: [number, number];
}

/** Cohen's kappa for two raters' labels on the same items: agreement corrected for chance. */
export function cohenKappa<T extends string | number | boolean>(pairs: ReadonlyArray<readonly [T, T]>): Kappa {
  const n = pairs.length;
  if (n === 0) return { n };
  const a = new Map<T, number>();
  const b = new Map<T, number>();
  let same = 0;
  for (const [x, y] of pairs) {
    if (x === y) same++;
    a.set(x, (a.get(x) ?? 0) + 1);
    b.set(y, (b.get(y) ?? 0) + 1);
  }
  const agreement = same / n;
  const levels: [number, number] = [a.size, b.size];
  let chance = 0;
  for (const [k, ca] of a) chance += (ca / n) * ((b.get(k) ?? 0) / n);
  if (chance >= 1) return { n, agreement, chance, levels };
  const kappa = (agreement - chance) / (1 - chance);
  const se = Math.sqrt((agreement * (1 - agreement)) / (n * (1 - chance) ** 2));
  return { n, agreement, chance, kappa, low: Math.max(-1, kappa - Z_95 * se), high: Math.min(1, kappa + Z_95 * se), levels };
}

/** Landis and Koch's words for a kappa value. */
export function kappaStrength(k: number): string {
  if (k < 0) return "worse than chance";
  if (k <= 0.2) return "slight";
  if (k <= 0.4) return "fair";
  if (k <= 0.6) return "moderate";
  if (k <= 0.8) return "substantial";
  return "almost perfect";
}

/** One person's blind verdict on a judged pair, with the judge's verdict as it stood. */
export interface HumanLabel {
  id: string;
  experiment: string;
  primary: string;
  candidate: string;
  prompt?: string;
  human: Preference;
  judge: { primary_score: number; candidate_score: number; winner: JudgeVerdict["winner"]; reason?: string };
  /** quality_tolerance when the label was given; the judge's class depends on it. */
  tolerance: number;
  /** The candidate's answer was shown to the person as A. */
  candidate_as_a: boolean;
  labelled_at: string;
}

export interface Calibration {
  n: number;
  /** Primary better, about the same, candidate better: person against judge. */
  three: Kappa;
  /** Candidate acceptable (same or better) against a pass on the judge. */
  acceptable: Kappa;
  /** matrix[person][judge] counts. */
  matrix: Record<Preference, Record<Preference, number>>;
  /** The judge passed a candidate the person rated worse. */
  lenient: number;
  /** The judge failed a candidate the person found acceptable. */
  strict: number;
}

const PREFS: Preference[] = ["primary", "same", "candidate"];

/** Person-against-judge agreement over saved labels, on three classes and on pass or fail. */
export function calibration(labels: HumanLabel[]): Calibration {
  const matrix = Object.fromEntries(PREFS.map((p) => [p, Object.fromEntries(PREFS.map((q) => [q, 0]))])) as Calibration["matrix"];
  const three: [Preference, Preference][] = [];
  const acceptable: [boolean, boolean][] = [];
  let lenient = 0;
  let strict = 0;
  for (const l of labels) {
    const judge = judgePreference({ ...l.judge, candidate_shown_first: false }, l.tolerance);
    matrix[l.human][judge]++;
    three.push([l.human, judge]);
    const humanOk = l.human !== "primary";
    const judgeOk = judge !== "primary";
    acceptable.push([humanOk, judgeOk]);
    if (!humanOk && judgeOk) lenient++;
    if (humanOk && !judgeOk) strict++;
  }
  return { n: labels.length, three: cohenKappa(three), acceptable: cohenKappa(acceptable), matrix, lenient, strict };
}
