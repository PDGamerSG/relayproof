/**
 * Test data for the Shadow Traffic suite.
 *
 * The suite runs against a gateway with the shadow plugin configured like
 * examples/shadow-demo/gateway/config.json: one experiment mirroring openai/gpt-4o to
 * a strong candidate (gpt-4o-mini) and a weak one (llama-3.1-8b), answered by the
 * demo's deterministic mock upstream.
 */

/** Source model of the demo experiment. */
export const SHADOW_SOURCE = "openai/gpt-4o";
/** Candidate the demo expects to clear the readiness thresholds. */
export const STRONG_CANDIDATE = "openai/gpt-4o-mini";
/** Candidate the demo expects to fail them: wrong answers, broken JSON and HTTP 503s. */
export const WEAK_CANDIDATE = "openai/llama-3.1-8b";

/** Readiness verdicts as the API returns them, and the label the page shows for each. */
export const VERDICT_LABELS: Record<string, string> = {
  collecting: "Collecting",
  ready: "Ready",
  promising: "Promising",
  not_ready: "Not ready",
};

/** Judge winners as the API returns them, and the badge the record details show. */
export const WINNER_LABELS: Record<string, string> = {
  primary: "Primary wins",
  candidate: "Candidate wins",
  tie: "Tie",
};

/** Outcome filter labels in the disagreements sheet. */
export const OUTCOME_FILTER_LABELS = {
  fail: "Disagreements (fail)",
  error: "Candidate errors",
  pass: "Agreements (pass)",
  all: "All outcomes",
} as const;

export interface ShadowModelRef {
  provider?: string;
  model: string;
}

export interface ShadowPair {
  experiment: string;
  source: ShadowModelRef;
  candidate: ShadowModelRef;
  samples: number;
  verdict: string;
  verdict_reason: string;
}

export interface ShadowSummary {
  sample_rate: number;
  judge_model?: string;
  counters: {
    eligible: number;
    sampled: number;
    enqueued: number;
    completed: number;
    candidate_errors: number;
    dropped: number;
    budget_skipped: number;
    in_flight: number;
    queue_depth: number;
  };
  experiments: { name?: string; source: ShadowModelRef; candidates: ShadowModelRef[] }[] | null;
  pairs: ShadowPair[] | null;
}

export interface ShadowRecord {
  id: string;
  primary: ShadowModelRef;
  candidate: ShadowModelRef;
  primary_answer?: { text: string };
  candidate_answer?: { text: string };
  candidate_error?: string;
  judge?: { winner: string; candidate_shown_first: boolean };
  pass: boolean;
}

export interface ShadowRecordsPage {
  records: ShadowRecord[] | null;
  total: number;
}

/** A routing rule as GET /api/routing/rules returns it (the fields this suite reads). */
export interface RoutingRuleRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  cel_expression: string;
  scope: string;
  scope_id?: string | null;
  priority: number;
  targets: { provider: string; model: string; weight: number }[];
}

/** Priority the gateway gives a canary rule when no priority is asked for. */
export const CANARY_BASE_PRIORITY = 10;

/**
 * Name of the canary rule the gateway builds for a pair. It depends only on the pair, not on
 * the share, so promoting the same pair again finds and ramps this rule.
 */
export function canaryRuleName(candidate: string, source: string = SHADOW_SOURCE): string {
  return `Shadow canary: ${source} -> ${candidate}`;
}

/** The sentence of the canary rule's description that states its share. */
export function canaryShareSentence(
  percent: number,
  candidate: string,
  source: string = SHADOW_SOURCE,
): string {
  return `Sends ${percent}% of ${source} traffic to ${candidate}.`;
}

/**
 * The priority a new canary gets: the lowest one from the default up that no global
 * routing rule holds, since the store allows one rule per priority in a scope.
 */
export function firstFreeCanaryPriority(
  rules: Pick<RoutingRuleRecord, "scope" | "priority">[],
): number {
  const taken = new Set(
    rules.filter((rule) => rule.scope === "global").map((rule) => rule.priority),
  );
  let priority = CANARY_BASE_PRIORITY;
  while (taken.has(priority)) priority++;
  return priority;
}

/** "provider/model", the form the page and the records API use for a model reference. */
export function modelLabel(ref: ShadowModelRef): string {
  return ref.provider ? `${ref.provider}/${ref.model}` : ref.model;
}

/**
 * Prompts the demo mock upstream knows (capital and arithmetic items of
 * examples/shadow-demo/dataset). Its answers are a pure function of model and prompt,
 * so mirroring this set gives the weak candidate a fixed mix of correct answers, wrong
 * answers and HTTP 503s, and the strong candidate almost only correct ones.
 */
export function createShadowTrafficPrompts(): string[] {
  const countries = [
    "France",
    "Japan",
    "Australia",
    "Canada",
    "Brazil",
    "Turkey",
    "Switzerland",
    "India",
    "South Africa",
    "New Zealand",
    "Nigeria",
    "Morocco",
    "Vietnam",
    "Pakistan",
    "Kazakhstan",
    "Germany",
    "Italy",
    "Spain",
    "Egypt",
    "Kenya",
  ];
  const prompts = countries.map((country) => `What is the capital of ${country}? Answer briefly.`);
  for (let i = 0; i < 24; i++) {
    const a = 12 + ((i * 7) % 31);
    const b = 9 + ((i * 5) % 17);
    prompts.push(`What is ${a} multiplied by ${b}? Reply with the number.`);
  }
  return prompts;
}

/**
 * Body of a chat completion sent to the shadow experiment's source model.
 */
export function createChatCompletionData(prompt: string) {
  return {
    model: SHADOW_SOURCE,
    messages: [{ role: "user", content: prompt }],
  };
}