/**
 * The Set up tab's logic, apart from the form: a draft of the shadow plugin's
 * settings, kept as the strings a form edits; the checks the plugin applies when
 * it loads (plugins/shadow/config.go, rollout.go); the JSON the gateway reads;
 * the commands to run it; and a rough estimate of what evaluation costs a day.
 */
import { REPO_URL } from "../data/site";
import type { ShadowRecord, Summary } from "./shadowClient";

/** Defaults the plugin applies to a field the config leaves out (config.go, rollout.go). */
export const DEFAULTS = {
  sampleRate: 0.1,
  maxConcurrency: 4,
  queueSize: 256,
  timeoutSeconds: 60,
  maxRecords: 5000,
  maxPayloadChars: 8000,
  minSamples: 20,
  minAgreement: 0.9,
  maxErrorRate: 0.05,
  qualityTolerance: 1,
  lexicalThreshold: 0.6,
  semanticThreshold: 0.85,
  maxJudgeErrorRate: 0.1,
  judgeSampleRate: 1,
  judgeMaxTokens: 300,
  canaryMinRequests: 20,
} as const;

/** Bifrost's built-in providers, the common ones first (core/schemas/bifrost.go). */
export const PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "vertex",
  "bedrock",
  "azure",
  "mistral",
  "groq",
  "cohere",
  "deepseek",
  "xai",
  "openrouter",
  "fireworks",
  "cerebras",
  "perplexity",
  "ollama",
  "vllm",
  "sgl",
  "huggingface",
  "nebius",
  "parasail",
  "databricks",
  "cloudflare",
] as const;

/** Models the project's own docs and demos use; any other name can be typed. */
export const MODEL_HINTS: Record<string, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-haiku-4-5"],
  openai: ["gpt-4o", "gpt-4o-mini"],
};
export const EMBEDDING_HINTS: Record<string, string[]> = {
  openai: ["text-embedding-3-small", "text-embedding-3-large"],
};

/** Providers that run on your own hardware: a key carries the server's URL, and usually no secret. */
const SELF_HOSTED: Record<string, string> = { ollama: "http://localhost:11434", vllm: "http://localhost:8000", sgl: "http://localhost:8000" };
/** Providers whose keys carry more than a value (deployments, regions, service accounts). */
const RICH_KEYS = new Set(["azure", "bedrock", "vertex", "databricks"]);

export interface ModelDraft {
  provider: string;
  model: string;
}

export interface CandidateDraft extends ModelDraft {
  /** Stable React key and field id; never written to the config. */
  key: string;
  /** Estimate input: dollars per candidate call. */
  cost: string;
}

export type Effort = "" | "low" | "medium" | "high";

/** Every value the form edits, as typed. Numbers stay strings until they are checked. */
export interface Draft {
  name: string;
  source: ModelDraft;
  candidates: CandidateDraft[];
  sampleRate: string;

  judgeOn: boolean;
  judge: ModelDraft;
  judgeSampleRate: string;
  judgeMaxTokens: string;
  judgeEffort: Effort;
  embeddingOn: boolean;
  embedding: ModelDraft;
  qualityFallback: "none" | "lexical";
  qualityTolerance: string;
  semanticThreshold: string;
  lexicalThreshold: string;

  minSamples: string;
  minAgreement: string;
  maxErrorRate: string;
  maxJudgeErrorRate: string;

  dailyBudget: string;
  virtualKeys: string;
  storePayloads: boolean;
  maxPayloadChars: string;
  allowForceHeader: boolean;
  maxConcurrency: string;
  queueSize: string;
  timeoutSeconds: string;
  persist: boolean;
  persistPath: string;
  maxRecords: string;

  canaryAutoRollback: boolean;
  canaryMinRequests: string;
  /** Empty follows thresholds.max_error_rate, as the plugin does. */
  canaryMaxErrorRate: string;
  /** 0 turns the latency check off. */
  canaryMaxLatencyRatio: string;
  canaryRollbackOnNotReady: boolean;

  // Estimate inputs: never part of the config.
  requestsPerDay: string;
  judgeCost: string;
  embeddingCost: string;
}

let nextKey = 0;
export const newCandidate = (provider = "", model = "", cost = "0.001"): CandidateDraft => ({
  key: `c${++nextKey}`,
  provider,
  model,
  cost,
});

/**
 * The starting point: the site's own quick start (Opus answers, Sonnet and Haiku
 * in its shadow, Opus judging), with the guard's automatic rollback on and
 * records kept on disk so the daily budget survives a restart.
 */
export function defaultDraft(): Draft {
  return {
    name: "",
    source: { provider: "anthropic", model: "claude-opus-5-5" },
    candidates: [newCandidate("anthropic", "claude-sonnet-5-5", "0.004"), newCandidate("anthropic", "claude-haiku-5-5", "0.0002")],
    sampleRate: "0.1",

    judgeOn: true,
    judge: { provider: "anthropic", model: "claude-opus-5-5" },
    judgeSampleRate: "1",
    // Opus thinks before it answers, and thinking counts against max_tokens.
    judgeMaxTokens: "2048",
    judgeEffort: "low",
    embeddingOn: false,
    embedding: { provider: "openai", model: "text-embedding-3-small" },
    qualityFallback: "none",
    qualityTolerance: String(DEFAULTS.qualityTolerance),
    semanticThreshold: String(DEFAULTS.semanticThreshold),
    lexicalThreshold: String(DEFAULTS.lexicalThreshold),

    minSamples: String(DEFAULTS.minSamples),
    minAgreement: String(DEFAULTS.minAgreement),
    maxErrorRate: String(DEFAULTS.maxErrorRate),
    maxJudgeErrorRate: String(DEFAULTS.maxJudgeErrorRate),

    dailyBudget: "20",
    virtualKeys: "",
    storePayloads: true,
    maxPayloadChars: String(DEFAULTS.maxPayloadChars),
    allowForceHeader: false,
    maxConcurrency: String(DEFAULTS.maxConcurrency),
    queueSize: String(DEFAULTS.queueSize),
    timeoutSeconds: String(DEFAULTS.timeoutSeconds),
    persist: true,
    persistPath: "shadow-records.jsonl",
    maxRecords: String(DEFAULTS.maxRecords),

    canaryAutoRollback: true,
    canaryMinRequests: String(DEFAULTS.canaryMinRequests),
    canaryMaxErrorRate: "",
    canaryMaxLatencyRatio: "0",
    canaryRollbackOnNotReady: true,

    requestsPerDay: "10000",
    judgeCost: "0.01",
    embeddingCost: "0.00002",
  };
}

/* Reading the connected gateway */

/** "anthropic/claude-opus-5-5" to its parts; the model may itself contain slashes. */
export function splitModel(id: string | undefined): ModelDraft | undefined {
  if (!id) return undefined;
  const i = id.indexOf("/");
  return i < 0 ? { provider: "", model: id } : { provider: id.slice(0, i), model: id.slice(i + 1) };
}

export const modelKey = (m: ModelDraft) => (m.provider.trim() ? `${m.provider.trim()}/${m.model.trim()}` : m.model.trim());

/** Up to three significant figures, for costs read from the gateway. */
const sig = (n: number) => String(Number(n.toPrecision(3)));

/** This gateway's rate of eligible requests, per day; undefined before it has run a minute. */
export function requestsPerDayFrom(summary: Summary, now: number): number | undefined {
  const seconds = (now - Date.parse(summary.started_at)) / 1000;
  if (!Number.isFinite(seconds) || seconds < 60 || summary.counters.eligible <= 0) return undefined;
  const perDay = (summary.counters.eligible / seconds) * 86400;
  // Two significant figures: the rate is an observation, not a forecast.
  return Number(perDay.toPrecision(2));
}

/**
 * The draft with everything the summary reports taken from it: one experiment,
 * the plugin-wide thresholds, the judge, embeddings, the budget and the canary
 * guard's rollback switch. What the summary does not report (judge tokens,
 * queue sizes, the allow-list, payload storage) keeps its current value. Costs
 * for the estimate come from the scorecards and the loaded comparisons.
 */
export function draftFromSummary(
  base: Draft,
  summary: Summary,
  experiment: number,
  records: ShadowRecord[],
  now: number,
): { draft: Draft; measured: string[] } {
  const exp = summary.experiments[experiment] ?? summary.experiments[0];
  const t = summary.thresholds;
  const measured: string[] = [];
  const next: Draft = {
    ...base,
    sampleRate: String(exp?.sample_rate ?? summary.sample_rate),
    qualityFallback: summary.quality_fallback === "lexical" ? "lexical" : "none",
    qualityTolerance: String(t.quality_tolerance),
    semanticThreshold: String(t.semantic_threshold),
    lexicalThreshold: String(t.lexical_threshold),
    minSamples: String(t.min_samples),
    minAgreement: String(t.min_agreement),
    maxErrorRate: String(t.max_error_rate),
    maxJudgeErrorRate: String(t.max_judge_error_rate),
    dailyBudget: String(summary.daily_budget_usd),
    canaryAutoRollback: summary.auto_rollback,
  };
  if (exp) {
    next.name = exp.name;
    next.source = { provider: exp.source.provider ?? "", model: exp.source.model };
    next.candidates = exp.candidates.map((c) => {
      const id = modelKey({ provider: c.provider ?? "", model: c.model });
      const pair = summary.pairs.find((p) => p.experiment === exp.name && modelKey({ provider: p.candidate.provider ?? "", model: p.candidate.model }) === id);
      const cost = pair && pair.avg_candidate_cost_usd > 0 ? sig(pair.avg_candidate_cost_usd) : undefined;
      const previous = base.candidates.find((b) => modelKey(b) === id)?.cost;
      const cand = newCandidate(c.provider ?? "", c.model, cost ?? previous ?? "0.001");
      if (cost) measured.push(`cand.${cand.key}.cost`);
      return cand;
    });
  }
  const judge = splitModel(summary.judge_model);
  next.judgeOn = Boolean(judge);
  if (judge) next.judge = judge;
  const embedding = splitModel(summary.embedding_model);
  next.embeddingOn = Boolean(embedding);
  if (embedding) next.embedding = embedding;

  // A comparison's eval cost is what judging it (and embedding it) cost.
  const judged = records.filter((r) => r.judge && r.eval_cost_usd > 0);
  if (judged.length > 0) {
    next.judgeCost = sig(judged.reduce((s, r) => s + r.eval_cost_usd, 0) / judged.length);
    measured.push("judgeCost");
  }
  const rate = requestsPerDayFrom(summary, now);
  if (rate !== undefined) {
    next.requestsPerDay = String(rate);
    measured.push("requestsPerDay");
  }
  return { draft: next, measured };
}

/** A draft saved by an earlier visit, checked field by field; anything odd falls back to the default. */
export function reviveDraft(saved: unknown): Draft | undefined {
  if (!saved || typeof saved !== "object") return undefined;
  const s = saved as Record<string, unknown>;
  const out = defaultDraft() as unknown as Record<string, unknown>;
  const isModel = (v: unknown): v is ModelDraft =>
    Boolean(v) && typeof (v as ModelDraft).provider === "string" && typeof (v as ModelDraft).model === "string";
  for (const [key, def] of Object.entries(out)) {
    const v = s[key];
    if (key === "candidates") {
      if (Array.isArray(v)) {
        // New keys: the counter restarts with the page.
        out.candidates = v.filter(isModel).map((c) => newCandidate(c.provider, c.model, typeof (c as CandidateDraft).cost === "string" ? (c as CandidateDraft).cost : "0.001"));
      }
    } else if (typeof def === "object") {
      if (isModel(v)) out[key] = { provider: v.provider, model: v.model };
    } else if (typeof v === typeof def) {
      out[key] = v;
    }
  }
  const d = out as unknown as Draft;
  if (!["", "low", "medium", "high"].includes(d.judgeEffort)) d.judgeEffort = "low";
  if (d.qualityFallback !== "lexical") d.qualityFallback = "none";
  return d;
}

/* Checking the draft */

export type Errors = Partial<Record<string, string>>;

export interface Check {
  /** Field id to plain message; any entry keeps the config from loading. */
  errors: Errors;
  /** Fine to load, but worth knowing. */
  warnings: string[];
}

/** A number, or undefined for an empty or unreadable field. */
export function num(s: string): number | undefined {
  const t = s.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const isWhole = (n: number | undefined): n is number => n !== undefined && Number.isInteger(n);

/** Splits the allow-list on commas and new lines and drops repeats. */
export function listOf(s: string): string[] {
  return [...new Set(s.split(/[\n,]/).map((v) => v.trim()).filter(Boolean))];
}

export function experimentName(d: Draft): string {
  if (d.name.trim()) return d.name.trim();
  // The plugin's own default: "<source> vs <candidate>, <candidate>".
  return `${modelKey(d.source) || "*"} vs ${d.candidates.map(modelKey).join(", ")}`;
}

export function check(d: Draft): Check {
  const errors: Errors = {};
  const warnings: string[] = [];
  const ratio = (field: keyof Draft, value: string, label = "Use a value from 0 to 1, for example 0.9.") => {
    const n = num(value);
    if (n === undefined || n < 0 || n > 1) errors[field] = label;
  };
  const whole = (field: keyof Draft, value: string, message = "Use a whole number, 1 or more.") => {
    const n = num(value);
    if (!isWhole(n) || n < 1) errors[field] = message;
  };

  // Experiment
  const rate = num(d.sampleRate);
  if (rate === undefined) errors.sampleRate = "Enter a share from 0 to 1, for example 0.1 for one request in ten.";
  else if (rate <= 0 || rate > 1) errors.sampleRate = "The sample rate must be more than 0 and at most 1.";
  if (!d.source.model.trim()) errors["source.model"] = "Enter the model whose traffic to copy, or * for every model.";
  if (d.candidates.length === 0) errors.candidates = "Add at least one candidate.";
  const seen = new Set<string>();
  const sourceProvider = d.source.provider.trim().toLowerCase();
  const sourceModel = d.source.model.trim().toLowerCase();
  for (const c of d.candidates) {
    const provider = c.provider.trim().toLowerCase();
    const model = c.model.trim().toLowerCase();
    if (!provider) errors[`cand.${c.key}.provider`] = "Choose the candidate's provider.";
    if (!model) {
      errors[`cand.${c.key}.model`] = "Enter the candidate's model.";
      continue;
    }
    if (model === sourceModel && (!sourceProvider || sourceProvider === provider)) {
      errors[`cand.${c.key}.model`] = "A candidate must differ from the source model.";
    } else if (seen.has(`${provider}/${model}`)) {
      errors[`cand.${c.key}.model`] = "This candidate is already in the list.";
    }
    seen.add(`${provider}/${model}`);
  }

  // Evaluation
  if (d.judgeOn) {
    if (!d.judge.provider.trim()) errors["judge.provider"] = "The judge needs a provider.";
    if (!d.judge.model.trim()) errors["judge.model"] = "The judge needs a model.";
    ratio("judgeSampleRate", d.judgeSampleRate, "Use a share from 0 to 1; 1 judges every pair.");
    const tokens = num(d.judgeMaxTokens);
    if (!isWhole(tokens) || tokens < 1) errors.judgeMaxTokens = "Use a whole number of tokens, 1 or more.";
    const tolerance = num(d.qualityTolerance);
    if (tolerance === undefined || tolerance < 0 || tolerance > 10) errors.qualityTolerance = "Use 0 to 10 judge points.";
    ratio("maxJudgeErrorRate", d.maxJudgeErrorRate);
    const judgeId = modelKey(d.judge).toLowerCase();
    if (d.candidates.some((c) => modelKey(c).toLowerCase() === judgeId)) {
      warnings.push("The judge is also a candidate. Judges tend to prefer their own answers; the Judge check tab measures how much.");
    }
  }
  if (d.embeddingOn) {
    if (!d.embedding.provider.trim()) errors["embedding.provider"] = "Embeddings need a provider.";
    if (!d.embedding.model.trim()) errors["embedding.model"] = "Embeddings need a model.";
    ratio("semanticThreshold", d.semanticThreshold);
  }
  if (d.qualityFallback === "lexical") ratio("lexicalThreshold", d.lexicalThreshold);
  if (!d.judgeOn && !d.embeddingOn && d.qualityFallback === "none") {
    warnings.push(
      "With no judge and no embeddings, only exact matches and the tool and JSON checks can score a pair. Answers worded differently stay unscored, so a candidate can stay at Collecting for a long time.",
    );
  }
  if (!d.judgeOn && d.qualityFallback === "lexical") {
    warnings.push("Lexical overlap counts shared words, not meaning: \"approved: true\" and \"approved: false\" overlap heavily.");
  }

  // Readiness gate
  whole("minSamples", d.minSamples);
  ratio("minAgreement", d.minAgreement);
  ratio("maxErrorRate", d.maxErrorRate);

  // Safety
  const budget = num(d.dailyBudget);
  if (budget === undefined) errors.dailyBudget = "Enter an amount in dollars, or 0 for no cap.";
  else if (budget < 0) errors.dailyBudget = "The budget cannot be negative. Use 0 for no cap.";
  else if (budget === 0) warnings.push("No daily budget: shadow, judge and embedding spend grows with traffic.");
  if (d.allowForceHeader) {
    warnings.push("With the force header allowed, any caller can mirror a request on demand and spend the shadow budget. Keep it for tests and demos.");
  }
  if (d.storePayloads) whole("maxPayloadChars", d.maxPayloadChars, "Use a whole number of characters, 1 or more.");
  whole("maxConcurrency", d.maxConcurrency);
  whole("queueSize", d.queueSize);
  whole("timeoutSeconds", d.timeoutSeconds, "Use a whole number of seconds, 1 or more.");
  whole("maxRecords", d.maxRecords);
  if (d.persist && !d.persistPath.trim()) errors.persistPath = "Enter a file path, or turn this off.";

  // Canary guard
  const minRequests = num(d.canaryMinRequests);
  if (!isWhole(minRequests) || minRequests < 1) errors.canaryMinRequests = "Use a whole number of requests, 1 or more.";
  if (d.canaryMaxErrorRate.trim()) ratio("canaryMaxErrorRate", d.canaryMaxErrorRate, "Use a value from 0 to 1, or leave it empty.");
  const latency = num(d.canaryMaxLatencyRatio || "0");
  if (latency === undefined || latency < 0) errors.canaryMaxLatencyRatio = "Use 0 to turn it off, or a multiple such as 3.";

  return { errors, warnings };
}

/* Writing the config */

export type Detail = "changes" | "all";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const ref = (m: ModelDraft): { [key: string]: Json } =>
  m.provider.trim() ? { provider: m.provider.trim(), model: m.model.trim() } : { model: m.model.trim() };

/**
 * The plugin's `config` object, with field names and nesting as config.go reads
 * them. "changes" writes what the docs' examples write: the experiment, the
 * evaluators, the budget, and any other field only where it differs from the
 * plugin's default. "all" writes every setting with the value it will have.
 * An empty or unreadable number falls back to the default; the form keeps the
 * result from being copied while check() reports errors.
 */
export function pluginConfig(d: Draft, detail: Detail): { [key: string]: Json } {
  const all = detail === "all";
  const n = (s: string, fallback: number) => num(s) ?? fallback;
  const differs = (s: string, def: number) => all || n(s, def) !== def;
  const out: { [key: string]: Json } = {};

  out.sample_rate = n(d.sampleRate, DEFAULTS.sampleRate);
  if (all || d.allowForceHeader) out.allow_force_header = d.allowForceHeader;
  const experiment: { [key: string]: Json } = {};
  if (d.name.trim()) experiment.name = d.name.trim();
  experiment.source = ref(d.source);
  experiment.candidates = d.candidates.map(ref);
  out.experiments = [experiment];

  if (d.judgeOn) {
    const judge: { [key: string]: Json } = { provider: d.judge.provider.trim(), model: d.judge.model.trim() };
    if (differs(d.judgeSampleRate, DEFAULTS.judgeSampleRate)) judge.sample_rate = n(d.judgeSampleRate, DEFAULTS.judgeSampleRate);
    if (differs(d.judgeMaxTokens, DEFAULTS.judgeMaxTokens)) judge.max_tokens = n(d.judgeMaxTokens, DEFAULTS.judgeMaxTokens);
    if (d.judgeEffort) judge.effort = d.judgeEffort;
    out.judge = judge;
  }
  if (d.embeddingOn) out.embedding = { provider: d.embedding.provider.trim(), model: d.embedding.model.trim() };
  if (all || d.qualityFallback !== "none") out.quality_fallback = d.qualityFallback;

  const budget = n(d.dailyBudget, 0);
  if (all || budget > 0) out.daily_budget_usd = budget;
  const keys = listOf(d.virtualKeys);
  if (keys.length > 0) out.virtual_keys = keys;
  if (all || !d.storePayloads) out.store_payloads = d.storePayloads;
  if (d.storePayloads && differs(d.maxPayloadChars, DEFAULTS.maxPayloadChars)) out.max_payload_chars = n(d.maxPayloadChars, DEFAULTS.maxPayloadChars);
  if (differs(d.maxConcurrency, DEFAULTS.maxConcurrency)) out.max_concurrency = n(d.maxConcurrency, DEFAULTS.maxConcurrency);
  if (differs(d.queueSize, DEFAULTS.queueSize)) out.queue_size = n(d.queueSize, DEFAULTS.queueSize);
  if (differs(d.timeoutSeconds, DEFAULTS.timeoutSeconds)) out.timeout_seconds = n(d.timeoutSeconds, DEFAULTS.timeoutSeconds);
  if (differs(d.maxRecords, DEFAULTS.maxRecords)) out.max_records = n(d.maxRecords, DEFAULTS.maxRecords);
  if (d.persist && d.persistPath.trim()) out.persist_path = d.persistPath.trim();

  // Thresholds: an explicit 0 is kept by the plugin, so write numbers as given.
  const thresholds: { [key: string]: Json } = {};
  // A threshold whose evaluator is off is hidden in the form: "all" writes its default.
  const gate: [string, string, number, boolean][] = [
    ["min_samples", d.minSamples, DEFAULTS.minSamples, true],
    ["min_agreement", d.minAgreement, DEFAULTS.minAgreement, true],
    ["max_error_rate", d.maxErrorRate, DEFAULTS.maxErrorRate, true],
    ["quality_tolerance", d.qualityTolerance, DEFAULTS.qualityTolerance, d.judgeOn],
    ["semantic_threshold", d.semanticThreshold, DEFAULTS.semanticThreshold, d.embeddingOn],
    ["lexical_threshold", d.lexicalThreshold, DEFAULTS.lexicalThreshold, d.qualityFallback === "lexical"],
    ["max_judge_error_rate", d.maxJudgeErrorRate, DEFAULTS.maxJudgeErrorRate, d.judgeOn],
  ];
  for (const [key, value, def, used] of gate) {
    if (used && differs(value, def)) thresholds[key] = n(value, def);
    else if (all) thresholds[key] = def;
  }
  if (Object.keys(thresholds).length > 0) out.thresholds = thresholds;

  const canary: { [key: string]: Json } = {};
  if (all || d.canaryAutoRollback) canary.auto_rollback = d.canaryAutoRollback;
  if (differs(d.canaryMinRequests, DEFAULTS.canaryMinRequests)) canary.min_requests = n(d.canaryMinRequests, DEFAULTS.canaryMinRequests);
  const canaryErrors = num(d.canaryMaxErrorRate);
  if (canaryErrors !== undefined) canary.max_error_rate = canaryErrors;
  else if (all) canary.max_error_rate = n(d.maxErrorRate, DEFAULTS.maxErrorRate);
  const latency = n(d.canaryMaxLatencyRatio || "0", 0);
  if (all || latency > 0) canary.max_latency_ratio = latency;
  if (all || !d.canaryRollbackOnNotReady) canary.rollback_on_not_ready = d.canaryRollbackOnNotReady;
  if (Object.keys(canary).length > 0) out.canary = canary;

  return out;
}

/** The entry for config.json's "plugins" list. */
export const pluginEntry = (d: Draft, detail: Detail) => ({ enabled: true, name: "shadow", config: pluginConfig(d, detail) });

/** Every provider the config calls, in the order they appear. */
export function providersUsed(d: Draft): string[] {
  const list = [d.source.provider, ...d.candidates.map((c) => c.provider)];
  if (d.judgeOn) list.push(d.judge.provider);
  if (d.embeddingOn) list.push(d.embedding.provider);
  return [...new Set(list.map((p) => p.trim()).filter(Boolean))];
}

function modelsFor(d: Draft, provider: string): string[] {
  const refs = [d.source, ...d.candidates, ...(d.judgeOn ? [d.judge] : []), ...(d.embeddingOn ? [d.embedding] : [])];
  return [...new Set(refs.filter((m) => m.provider.trim() === provider && m.model.trim() && m.model.trim() !== "*").map((m) => m.model.trim()))];
}

/** Bifrost's page for a provider: keys, regions, deployments. */
export const providerDocs = (provider: string) => `https://docs.getbifrost.ai/providers/supported-providers/${provider}`;

/** "anthropic" to "ANTHROPIC_API_KEY". */
export const keyVariable = (provider: string) => `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;

export interface ProviderNote {
  provider: string;
  note?: "self-hosted" | "rich-key";
}

export function providerNotes(d: Draft): ProviderNote[] {
  return providersUsed(d).map((provider) => ({
    provider,
    note: provider in SELF_HOSTED ? "self-hosted" : RICH_KEYS.has(provider) ? "rich-key" : undefined,
  }));
}

/**
 * A config.json that starts a gateway on its own: a key read from the
 * environment for each provider, this console's origin allowed, the plugin.
 */
export function fullConfig(d: Draft, detail: Detail, origin: string): { [key: string]: Json } {
  const providers: { [key: string]: Json } = {};
  for (const provider of providersUsed(d)) {
    const url = SELF_HOSTED[provider];
    if (!url) {
      providers[provider] = { keys: [{ name: provider, value: `env.${keyVariable(provider)}`, weight: 1, models: ["*"] }] };
      continue;
    }
    // A local server: no secret, and the key says where the server listens (vLLM also names its model).
    const models = modelsFor(d, provider);
    const server: { [key: string]: Json } = { url };
    if (provider === "vllm" && models[0]) server.model_name = models[0];
    providers[provider] = {
      keys: [{ name: `${provider}-local`, value: "", weight: 1, models: provider === "vllm" ? models : ["*"], [`${provider}_key_config`]: server }],
    };
  }
  return {
    $schema: "https://www.getbifrost.ai/schema",
    client: { allowed_origins: [origin] },
    providers,
    plugins: [pluginEntry(d, detail)],
  };
}

/**
 * JSON laid out the way the docs write it: an object or array of plain values
 * stays on one line when it fits, everything else is indented by two.
 */
export function formatJSON(value: unknown, width = 80): string {
  const flat = (v: unknown): string | undefined => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      if (v.some((x) => x !== null && typeof x === "object" && !(isPlainObject(x) && Object.values(x).every(isScalar)))) return undefined;
      const parts = v.map(flat);
      return parts.some((p) => p === undefined) ? undefined : `[${parts.join(", ")}]`;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    if (!entries.every(([, x]) => isScalar(x))) return undefined;
    return `{ ${entries.map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(", ")} }`;
  };
  const write = (v: unknown, indent: string, lead: number): string => {
    const one = flat(v);
    if (one !== undefined && lead + one.length <= width) return one;
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    const inner = `${indent}  `;
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return `[\n${v.map((x) => inner + write(x, inner, inner.length)).join(",\n")}\n${indent}]`;
    }
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return `{\n${entries
      .map(([k, x]) => {
        const key = `${JSON.stringify(k)}: `;
        return inner + key + write(x, inner, inner.length + key.length);
      })
      .join(",\n")}\n${indent}}`;
  };
  return write(value, "", 0);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isScalar(v: unknown): boolean {
  return v === null || typeof v !== "object" || (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object") && v.length <= 4);
}

/* Commands */

export type RunAuth = "token" | "login" | "none";

export interface RunOptions {
  /** Where the gateway listens, e.g. http://localhost:8080. */
  gateway: string;
  auth: RunAuth;
  /** This console's origin, for client.allowed_origins. */
  origin: string;
}

/** Wraps a string for a POSIX shell's single quotes. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const authFlags = (auth: RunAuth) =>
  auth === "token" ? ` \\\n  -H "X-Bifrost-Setup-Token: $BIFROST_SETUP_TOKEN"` : auth === "login" ? ` \\\n  -u "$BIFROST_USER:$BIFROST_PASSWORD"` : "";

export function gatewayBase(input: string): string {
  const t = input.trim().replace(/\/+$/, "");
  if (!t) return "http://localhost:8080";
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

function portOf(base: string): string {
  try {
    const url = new URL(base);
    return url.port || (url.protocol === "https:" ? "443" : "80");
  } catch {
    return "8080";
  }
}

export interface Commands {
  build: string;
  start: string;
  apply: string;
  summary: string;
  test: string;
  promote: string;
  origins: string;
}

export function commands(d: Draft, o: RunOptions, detail: Detail): Commands {
  const base = gatewayBase(o.gateway);
  const auth = authFlags(o.auth);
  const repo = REPO_URL.replace(/\/+$/, "");
  const folder = repo.slice(repo.lastIndexOf("/") + 1);
  const keys = providerNotes(d)
    .filter((p) => p.note !== "self-hosted")
    .map((p) => `export ${keyVariable(p.provider)}="..."`);

  const build = [
    `git clone ${repo}.git`,
    `cd ${folder}`,
    "# Clones Bifrost at the pinned commit, adds the plugin, applies the patches, builds",
    "bifrost-shadow/scripts/setup.sh    # SKIP_UI=1 skips the dashboard build",
  ].join("\n");

  const start = [
    "# The whole config.json from step 2, in the gateway's app directory",
    "mkdir -p gateway && mv ~/Downloads/config.json gateway/config.json",
    ...(keys.length > 0 ? ["# A key for each provider the config names", ...keys] : []),
    ...(o.auth === "token"
      ? ["# Management calls carry this until the gateway has an admin account", 'export BIFROST_SETUP_TOKEN="$(openssl rand -hex 24)"']
      : []),
    `(cd gateway && ../bifrost/tmp/bifrost-http -app-dir . -port ${portOf(base)})`,
  ].join("\n");

  const body = JSON.stringify({ name: "shadow", enabled: true, path: "", config: pluginConfig(d, detail) });
  const apply = [
    "# A running gateway with a config store: add the plugin without a restart",
    `curl -s -X POST ${base}/api/plugins${auth} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d ${shellQuote(body)}`,
    "# Already enabled? Send the same body with -X PUT to /api/plugins/shadow",
  ].join("\n");

  const summary = `curl -s ${base}/api/shadow/summary${auth}`;

  const sourceProvider = d.source.provider.trim();
  const sourceModel = d.source.model.trim();
  const model =
    sourceModel && sourceModel !== "*" ? (sourceProvider ? `${sourceProvider}/${sourceModel}` : `your-provider/${sourceModel}`) : `${sourceProvider || "your-provider"}/your-model`;
  const request = JSON.stringify({ model, messages: [{ role: "user", content: "What is the capital of Italy? Answer briefly." }] });
  const vk = listOf(d.virtualKeys).length > 0 ? ` \\\n  -H "x-bf-vk: $VIRTUAL_KEY"` : "";
  const call = (extra: string) =>
    `curl -s -i ${base}/v1/chat/completions \\\n  -H "Content-Type: application/json"${extra}${vk} \\\n  -d ${shellQuote(request)}`;
  const rate = num(d.sampleRate) ?? DEFAULTS.sampleRate;
  const tries = Math.min(50, Math.max(5, Math.ceil(2 / Math.max(rate, 0.01))));
  const test = [
    ...(vk ? ["# The allow-list mirrors only requests made with one of its virtual keys"] : []),
    ...(d.allowForceHeader
      ? ["# The response carries x-bf-shadow: sampled when the request was mirrored", call(` \\\n  -H "x-bf-shadow: force"`)]
      : [
          `# The force header is off, so requests are sampled: about ${tries} requests give a few comparisons`,
          `for i in $(seq ${tries}); do`,
          `  ${call("").replace(/\n/g, "\n  ").replace("curl -s -i", "curl -s -o /dev/null")}`,
          "done",
        ]),
  ].join("\n");

  const candidate = d.candidates[0] ? modelKey(d.candidates[0]) : "provider/model";
  const promote = [
    "# The plan only: the routing rule and any rule that would get in its way",
    `curl -s -X POST ${base}/api/shadow/promote${auth} \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d ${shellQuote(JSON.stringify({ experiment: experimentName(d), candidate, weight: 0.1, dry_run: true }))}`,
  ].join("\n");

  const origins = formatJSON({ client: { allowed_origins: [o.origin] } });

  return { build, start, apply, summary, test, promote, origins };
}

/* Spend estimate */

export interface SpendEstimate {
  sampledPerDay: number;
  /** Comparisons a day: one per sampled request and candidate. */
  pairsPerDay: number;
  /** Dollars per sampled request, across every candidate and its evaluation. */
  perSampled: number;
  daily: number;
  monthly: number;
  candidates: { key: string; label: string; daily: number }[];
  evaluation: number;
  /** Share of a day's sampled traffic the budget pays for; undefined without a cap. */
  budgetCovers?: number;
}

/**
 * requests a day × sample rate × each candidate's (call + judged share × judge
 * call + embedding call). Undefined while an input is missing or negative.
 */
export function estimate(d: Draft): { errors: Errors; result?: SpendEstimate } {
  const errors: Errors = {};
  const money = (field: string, value: string) => {
    const n = num(value);
    if (n === undefined || n < 0) {
      errors[field] = "Enter a cost in dollars, 0 or more.";
      return 0;
    }
    return n;
  };
  const requests = num(d.requestsPerDay);
  if (requests === undefined || requests < 0) errors.requestsPerDay = "Enter a number of requests, 0 or more.";
  const costs = d.candidates.map((c) => money(`cand.${c.key}.cost`, c.cost));
  const judge = d.judgeOn ? money("judgeCost", d.judgeCost) : 0;
  const embedding = d.embeddingOn ? money("embeddingCost", d.embeddingCost) : 0;
  const rate = num(d.sampleRate);
  const judged = d.judgeOn ? (num(d.judgeSampleRate) ?? DEFAULTS.judgeSampleRate) : 0;
  if (Object.keys(errors).length > 0 || requests === undefined || rate === undefined || rate <= 0 || rate > 1) return { errors };

  const sampledPerDay = requests * rate;
  const evalPerPair = judged * judge + embedding;
  const perSampled = costs.reduce((s, c) => s + c + evalPerPair, 0);
  const daily = sampledPerDay * perSampled;
  const budget = num(d.dailyBudget) ?? 0;
  return {
    errors,
    result: {
      sampledPerDay,
      pairsPerDay: sampledPerDay * d.candidates.length,
      perSampled,
      daily,
      monthly: daily * 30,
      candidates: d.candidates.map((c, i) => ({ key: c.key, label: modelKey(c), daily: sampledPerDay * costs[i] })),
      evaluation: sampledPerDay * d.candidates.length * evalPerPair,
      budgetCovers: budget > 0 && daily > 0 ? Math.min(1, budget / daily) : undefined,
    },
  };
}

/** "$0.42", "$12", "$1,240": cents only while they matter. */
export function dollars(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toPrecision(2)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
