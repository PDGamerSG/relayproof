// Typed client for the Bifrost Shadow API (/api/shadow/*), for a frontend that
// runs apart from the gateway. Dependency-free: it uses fetch, so it works in
// browsers, Next.js (server and client), Vite apps, Node 18+ and Bun.
//
// The types mirror api/openapi.yaml, which is checked against live gateway
// responses. See api/README.md for authentication, CORS and polling.

// ---------- types ----------

export type Verdict = "collecting" | "promising" | "ready" | "not_ready";

/** Signal that decided a pair. "structural" appears only in records from older versions. */
export type PassBasis =
  | "tool_selection"
  | "json_schema"
  | "judge"
  | "exact"
  | "tool_arguments"
  | "semantic"
  | "lexical"
  | "unscored"
  | "structural";

export type ToolDiff = "missing" | "extra" | "different_tool" | "different_args";

export interface ModelRef {
  provider?: string;
  model: string;
}

export interface Counters {
  eligible: number;
  sampled: number;
  enqueued: number;
  dropped: number;
  budget_skipped: number;
  completed: number;
  candidate_errors: number;
  in_flight: number;
  queue_depth: number;
}

export interface Thresholds {
  min_samples: number;
  min_agreement: number;
  max_error_rate: number;
  quality_tolerance: number;
  lexical_threshold: number;
  semantic_threshold: number;
  max_judge_error_rate: number;
}

export interface Experiment {
  name: string;
  source: ModelRef;
  candidates: ModelRef[];
  sample_rate?: number;
}

export interface LatencyStats {
  p50_ms: number;
  p95_ms: number;
}

/** Scorecard for one candidate within one experiment. */
export interface PairSummary {
  experiment: string;
  source: ModelRef;
  candidate: ModelRef;
  primary_models: string[] | null;
  samples: number;
  completed: number;
  errors: number;
  passes: number;
  judged: number;
  scored: number;
  unscored: number;
  judge_errors: number;
  judge_error_rate: number;
  pass_basis_counts: Partial<Record<PassBasis, number>>;
  error_rate: number;
  /** passes / (scored + errors) */
  agreement_rate: number;
  /** 95% Wilson lower bound of agreement; "ready" needs it >= thresholds.min_agreement */
  agreement_lower_bound: number;
  exact_match_rate: number;
  finish_reason_match_rate: number;
  tool_turns: number;
  tool_name_match_rate?: number;
  tool_diffs?: Partial<Record<ToolDiff, number>>;
  judge_candidate_wins: number;
  judge_ties: number;
  judge_candidate_losses: number;
  avg_primary_score: number;
  avg_candidate_score: number;
  avg_lexical_similarity: number;
  avg_semantic_similarity?: number;
  tool_call_match_rate?: number;
  json_match_rate?: number;
  primary_latency: LatencyStats;
  candidate_latency: LatencyStats;
  avg_primary_cost_usd: number;
  avg_candidate_cost_usd: number;
  /** Negative when the candidate is pricier. */
  savings_pct: number;
  savings_per_million_usd: number;
  projected_monthly_savings_usd: number;
  eval_spend_usd: number;
  shadow_spend_usd: number;
  verdict: Verdict;
  verdict_reason: string;
  first_seen: string;
  last_seen: string;
}

export interface Summary {
  started_at: string;
  sample_rate: number;
  judge_model?: string;
  embedding_model?: string;
  quality_fallback: "none" | "lexical";
  auto_rollback: boolean;
  active_canaries: number;
  /** 0 means unlimited. */
  daily_budget_usd: number;
  spend_today_usd: number;
  spend_reserved_usd: number;
  budget_exhausted: boolean;
  counters: Counters;
  thresholds: Thresholds;
  experiments: Experiment[];
  pairs: PairSummary[];
}

export interface ToolCall {
  name: string;
  arguments: string;
}

export interface Answer {
  text: string;
  tool_calls?: ToolCall[];
  finish_reason?: string;
}

export interface Comparison {
  lexical_similarity: number;
  semantic_similarity?: number;
  length_ratio: number;
  tool_calls_match?: boolean;
  tool_names_match?: boolean;
  tool_call_diff?: ToolDiff;
  json_match?: boolean;
  json_values_match?: boolean;
  exact_match: boolean;
  finish_reason_match: boolean;
}

export interface JudgeVerdict {
  primary_score: number;
  candidate_score: number;
  winner: "primary" | "candidate" | "tie";
  reason?: string;
  candidate_shown_first: boolean;
}

export interface ShadowRecord {
  id: string;
  request_id: string;
  experiment: string;
  created_at: string;
  stream: boolean;
  primary: ModelRef;
  candidate: ModelRef;
  prompt?: string;
  primary_answer?: Answer;
  candidate_answer?: Answer;
  primary_latency_ms: number;
  candidate_latency_ms: number;
  primary_input_tokens: number;
  primary_output_tokens: number;
  candidate_input_tokens: number;
  candidate_output_tokens: number;
  primary_cost_usd: number;
  candidate_cost_usd: number;
  eval_cost_usd: number;
  candidate_error?: string;
  comparison?: Comparison;
  judge?: JudgeVerdict;
  judge_error?: string;
  pass: boolean;
  pass_basis?: PassBasis;
}

export interface RecordFilter {
  experiment?: string;
  /** provider/model */
  candidate?: string;
  outcome?: "all" | "pass" | "fail" | "error";
  /** Default 50, maximum 500. */
  limit?: number;
  offset?: number;
}

export interface RoutingTarget {
  provider?: string;
  model?: string;
  weight: number;
}

export interface CanaryRuleBody {
  name: string;
  description: string;
  enabled: boolean;
  cel_expression: string;
  targets: RoutingTarget[];
  scope: string;
  priority: number;
}

export interface RoutingRule {
  id: string;
  name: string;
  description: string;
  enabled?: boolean;
  cel_expression: string;
  targets: RoutingTarget[];
  scope: string;
  scope_id: string | null;
  chain_rule: boolean;
  priority: number;
  config_hash?: string;
  created_at?: string;
  updated_at?: string;
}

export interface TargetHealth {
  requests: number;
  errors: number;
  error_rate: number;
  p50_ms: number;
  p95_ms: number;
}

export interface CanaryHealth {
  status: "watching" | "healthy" | "unhealthy";
  reason: string;
  source: TargetHealth;
  candidate: TargetHealth;
  verdict?: Verdict;
}

/**
 * A canary's ramp: the weights the canary guard moves it through and the step it
 * is at. A step ends once it has served min_requests candidate requests,
 * hold_seconds have passed and the canary is healthy.
 */
export interface CanaryRamp {
  /** Strictly ascending shares of source traffic. */
  steps: number[];
  /** Index into steps of the weight served now. */
  current_step: number;
  /** When the canary reached the current step. */
  step_started_at: string;
  /** Live candidate requests at this step (restarts with the gateway; 0 in events). */
  step_requests: number;
  min_requests: number;
  hold_seconds: number;
  /** The next step's weight; absent once the ramp is complete. */
  next_weight?: number;
  /** The canary reached the last step: still guarded, moved no further. */
  completed: boolean;
  /** What the ramp is waiting for, e.g. "step 1 of 4 (10%): 12 of 50 candidate requests". Live views only. */
  reason?: string;
}

export interface Canary {
  experiment: string;
  source: ModelRef;
  candidate: ModelRef;
  weight: number;
  rule_id: string;
  rule_name: string;
  since: string;
  override?: boolean;
  /** Live health; for a ramping canary, of the current step only. */
  health: CanaryHealth;
  /** Present when the canary was promoted with a ramp. */
  ramp?: CanaryRamp;
}

/**
 * "ramp": the canary guard moved a ramping canary to its next step;
 * "ramp_complete": to its last step (instead of "ramp").
 */
export type RolloutAction = "promote" | "rollback" | "auto_rollback" | "ramp" | "ramp_complete";

export interface RolloutEvent {
  id: string;
  at: string;
  action: RolloutAction;
  experiment: string;
  source: ModelRef;
  candidate: ModelRef;
  /** Candidate's share after the action; 0 after a rollback. */
  weight: number;
  rule_id?: string;
  rule_name?: string;
  override?: boolean;
  reason?: string;
  actor: "api" | "canary_guard";
  evidence?: PairSummary;
  /** The health behind an auto_rollback, or the one a ramp step rested on. */
  health?: CanaryHealth;
  /** The ramp after the action: on a promotion that starts one, and on ramp and ramp_complete events. */
  ramp?: CanaryRamp;
}

export interface Rollouts {
  auto_rollback: boolean;
  canaries: Canary[];
  events: RolloutEvent[];
}

/** Let the canary guard raise the weight step by step while the canary stays healthy. */
export interface RampRequest {
  /** 2 to 20 strictly ascending shares, each 0.0001 to 1. The first is the promoted weight. */
  steps: number[];
  /** Candidate requests each step must serve. Default and minimum: the guard's canary.min_requests. */
  min_requests?: number;
  /** Minimum seconds at each step, 0 to 604800. Default 60. */
  hold_seconds?: number;
}

export interface PromoteRequest {
  experiment: string;
  /** provider/model */
  candidate: string;
  /** Candidate's share of source traffic, 0.0001 to 1. Default 0.1. With ramp, leave it out or send ramp.steps[0]. */
  weight?: number;
  /** New rules only. Default: first free global priority from 10. */
  priority?: number;
  /** Required to promote a candidate whose verdict is not "ready". */
  override_reason?: string;
  dry_run?: boolean;
  /** Replaces a running ramp; a promotion without one cancels it. */
  ramp?: RampRequest;
}

export interface Promotion {
  action: "create" | "update";
  dry_run: boolean;
  rule: RoutingRule;
  warnings: string[];
  evidence: PairSummary;
  /**
   * The ramp as it starts, when the request had one. A gateway without ramp
   * support ignores the request's ramp and omits this, so check it on a dry run.
   */
  ramp?: CanaryRamp;
  event?: RolloutEvent;
}

export interface RollbackRequest {
  experiment: string;
  candidate: string;
  reason?: string;
}

export interface RollbackResult {
  action: "update" | "delete" | "none";
  rule?: RoutingRule;
  event?: RolloutEvent;
}

export interface ExportBundle {
  exported_at: string;
  summary: Summary;
  records: ShadowRecord[];
  rollouts: Rollouts;
}

// ---------- errors ----------

/** Body of a 409 from promote: the candidate is not ready and no override reason was given. */
export interface NotReadyRefusal {
  error: string;
  verdict: Verdict;
  verdict_reason: string;
  evidence: PairSummary;
}

/** Body of a 409 from promote: an earlier routing rule would keep the canary from serving traffic. */
export interface ConflictRefusal {
  error: string;
  conflicts: string[];
  warnings: string[];
  rule: RoutingRule;
}

/** Any non-2xx answer. `body` is the parsed JSON when there was some. */
export class ShadowApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ShadowApiError";
    this.status = status;
    this.body = body;
  }

  /** The shadow plugin is not enabled on this gateway. */
  get pluginDisabled(): boolean {
    return this.status === 404 && this.message.includes("shadow plugin is not enabled");
  }

  notReady(): NotReadyRefusal | undefined {
    const b = this.body as Partial<NotReadyRefusal> | undefined;
    return this.status === 409 && b?.verdict ? (b as NotReadyRefusal) : undefined;
  }

  conflict(): ConflictRefusal | undefined {
    const b = this.body as Partial<ConflictRefusal> | undefined;
    return this.status === 409 && Array.isArray(b?.conflicts) ? (b as ConflictRefusal) : undefined;
  }
}

// ---------- client ----------

export interface ShadowClientOptions {
  /** Gateway origin, e.g. "http://localhost:8080". Use "" to call a same-origin proxy. */
  baseUrl: string;
  /** Sent as X-Bifrost-Setup-Token (gateway with a config store, before dashboard auth is set up). */
  setupToken?: string;
  /** Dashboard admin credentials, sent as HTTP Basic auth. Keep these server-side. */
  basicAuth?: { username: string; password: string };
  /**
   * "include" sends the session cookie from POST /api/session/login. The gateway
   * must list your origin in client.allowed_origins (localhost is always allowed).
   */
  credentials?: RequestCredentials;
  /** Extra headers on every call. */
  headers?: Record<string, string>;
  /** Custom fetch (tests, Next.js caching options, polyfills). */
  fetch?: typeof fetch;
}

const encodeBasic = (user: string, pass: string): string => {
  const raw = `${user}:${pass}`;
  if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(raw)));
  // Node without btoa.
  return (globalThis as unknown as { Buffer: { from(s: string): { toString(enc: string): string } } }).Buffer.from(raw).toString("base64");
};

const query = (params: Record<string, string | number | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
};

export class ShadowClient {
  private readonly opts: ShadowClientOptions;
  private readonly doFetch: typeof fetch;

  constructor(opts: ShadowClientOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, "") };
    this.doFetch = opts.fetch ?? fetch.bind(globalThis);
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", ...this.opts.headers };
    if (json) h["Content-Type"] = "application/json";
    if (this.opts.setupToken) h["X-Bifrost-Setup-Token"] = this.opts.setupToken;
    if (this.opts.basicAuth) h.Authorization = `Basic ${encodeBasic(this.opts.basicAuth.username, this.opts.basicAuth.password)}`;
    return h;
  }

  private async raw(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await this.doFetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: this.opts.credentials,
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }
      const p = parsed as { error?: string | { message?: string } } | undefined;
      const message = typeof p?.error === "string" ? p.error : p?.error?.message ?? `HTTP ${res.status}`;
      throw new ShadowApiError(res.status, message, parsed);
    }
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return (await (await this.raw(method, path, body, signal)).json()) as T;
  }

  /** Counters, spend and one scorecard per candidate. Cheap; poll every 2-5 s. */
  summary(signal?: AbortSignal): Promise<Summary> {
    return this.json("GET", "/api/shadow/summary", undefined, signal);
  }

  /** One page of comparisons, newest first. */
  records(filter: RecordFilter = {}, signal?: AbortSignal): Promise<{ records: ShadowRecord[]; total: number }> {
    return this.json("GET", `/api/shadow/records${query({ ...filter })}`, undefined, signal);
  }

  /** Disagreements for one candidate: failing pairs, newest first. */
  disagreements(experiment: string, candidate: string, limit = 50, offset = 0): Promise<{ records: ShadowRecord[]; total: number }> {
    return this.records({ experiment, candidate, outcome: "fail", limit, offset });
  }

  record(id: string, signal?: AbortSignal): Promise<ShadowRecord> {
    return this.json("GET", `/api/shadow/records/${encodeURIComponent(id)}`, undefined, signal);
  }

  /** Clear records and counters. Spend, rollouts and canaries are kept. */
  reset(): Promise<{ message: string }> {
    return this.json("DELETE", "/api/shadow/records");
  }

  /**
   * Promote a candidate to a canary. Throws ShadowApiError with status 409:
   * use err.notReady() / err.conflict() to explain the refusal.
   */
  promote(req: PromoteRequest): Promise<Promotion> {
    return this.json("POST", "/api/shadow/promote", req);
  }

  /** The promotion plan without writing anything. */
  planPromotion(req: Omit<PromoteRequest, "dry_run">): Promise<Promotion> {
    return this.promote({ ...req, dry_run: true });
  }

  rollback(req: RollbackRequest): Promise<RollbackResult> {
    return this.json("POST", "/api/shadow/rollback", req);
  }

  /** Active canaries with live health, and the rollout log newest first. */
  rollouts(signal?: AbortSignal): Promise<Rollouts> {
    return this.json("GET", "/api/shadow/rollouts", undefined, signal);
  }

  /** Routing-rule body only (no readiness or conflict checks). Prefer planPromotion. */
  canaryRule(experiment: string, candidate: string, weight = 0.1, priority?: number): Promise<CanaryRuleBody> {
    return this.json("GET", `/api/shadow/canary-rule${query({ experiment, candidate, weight, priority })}`);
  }

  /** Everything as one JSON document. */
  exportJSON(filter: Omit<RecordFilter, "limit" | "offset"> = {}): Promise<ExportBundle> {
    return this.json("GET", `/api/shadow/export${query({ format: "json", ...filter })}`);
  }

  /** A CSV file as a Blob (save it with an object URL). */
  async exportCSV(kind: "scorecards" | "records" = "scorecards", filter: Omit<RecordFilter, "limit" | "offset"> = {}): Promise<Blob> {
    const res = await this.raw("GET", `/api/shadow/export${query({ format: "csv", kind, ...filter })}`);
    return res.blob();
  }

  /** Direct link for a download button (works when auth is a cookie or there is none). */
  exportUrl(format: "json" | "csv" = "csv", kind: "scorecards" | "records" = "scorecards"): string {
    return `${this.opts.baseUrl}/api/shadow/export${query({ format, kind: format === "csv" ? kind : undefined })}`;
  }

  /** Whether the gateway answers and the shadow plugin is enabled. */
  async status(): Promise<"ok" | "plugin_disabled" | "unreachable" | "unauthorized"> {
    try {
      await this.summary();
      return "ok";
    } catch (err) {
      if (err instanceof ShadowApiError) {
        if (err.pluginDisabled) return "plugin_disabled";
        if (err.status === 401 || err.status === 403) return "unauthorized";
      }
      return "unreachable";
    }
  }
}

/**
 * Poll an endpoint on an interval, skipping a tick while the previous call is
 * still running. Returns a stop function.
 *
 *   const stop = poll(() => client.summary(), 3000, setSummary, console.error);
 */
export function poll<T>(fn: () => Promise<T>, intervalMs: number, onData: (value: T) => void, onError?: (err: unknown) => void): () => void {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const value = await fn();
      if (!stopped) onData(value);
    } catch (err) {
      if (!stopped) onError?.(err);
    } finally {
      running = false;
    }
  };
  void tick();
  const id = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(id);
  };
}
