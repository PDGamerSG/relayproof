/**
 * Shadow Traffic Type Definitions
 * Mirrors the JSON exchanged with /api/shadow/* (plugins/shadow: api.go, store.go, compare.go, judge.go, config.go).
 */

/** A provider/model pair. An empty provider matches any provider; model "*" matches any model as a source. */
export interface ShadowModelRef {
	provider?: string;
	model: string;
}

export interface ShadowExperiment {
	name?: string;
	source: ShadowModelRef;
	candidates: ShadowModelRef[];
	sample_rate?: number;
}

export interface ShadowThresholds {
	min_samples?: number;
	min_agreement?: number;
	max_error_rate?: number;
	quality_tolerance?: number;
	lexical_threshold?: number;
	semantic_threshold?: number;
}

export interface ShadowCounters {
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

export interface ShadowLatencyStats {
	p50_ms: number;
	p95_ms: number;
}

/** Readiness verdicts (store.go Verdict* constants). */
export type ShadowVerdict = "collecting" | "ready" | "promising" | "not_ready";

/** Scorecard for one candidate within one experiment. */
export interface ShadowPairSummary {
	experiment: string;
	source: ShadowModelRef;
	candidate: ShadowModelRef;
	primary_models: string[] | null;

	samples: number;
	completed: number;
	errors: number;
	passes: number;
	judged: number;

	error_rate: number;
	agreement_rate: number;
	agreement_lower_bound: number;

	judge_candidate_wins: number;
	judge_ties: number;
	judge_candidate_losses: number;
	avg_primary_score: number;
	avg_candidate_score: number;

	avg_lexical_similarity: number;
	avg_semantic_similarity?: number;
	tool_call_match_rate?: number;
	json_match_rate?: number;

	primary_latency: ShadowLatencyStats;
	candidate_latency: ShadowLatencyStats;

	avg_primary_cost_usd: number;
	avg_candidate_cost_usd: number;
	/** Relative cost reduction per request in percent (negative = candidate is pricier). */
	savings_pct: number;
	savings_per_million_usd: number;
	projected_monthly_savings_usd: number;
	eval_spend_usd: number;
	shadow_spend_usd: number;

	verdict: ShadowVerdict;
	verdict_reason: string;

	first_seen: string;
	last_seen: string;
}

/** Payload of GET /api/shadow/summary. */
export interface ShadowSummary {
	started_at: string;
	sample_rate: number;
	judge_model?: string;
	embedding_model?: string;
	/** 0 means unlimited. */
	daily_budget_usd: number;
	spend_today_usd: number;
	budget_exhausted: boolean;
	counters: ShadowCounters;
	thresholds: ShadowThresholds;
	experiments: ShadowExperiment[] | null;
	pairs: ShadowPairSummary[] | null;
}

export interface ShadowToolCall {
	name: string;
	arguments: string;
}

export interface ShadowAnswer {
	text: string;
	tool_calls?: ShadowToolCall[];
	finish_reason?: string;
}

export interface ShadowComparison {
	lexical_similarity: number;
	semantic_similarity?: number;
	length_ratio: number;
	tool_calls_match?: boolean;
	json_match?: boolean;
	finish_reason_match: boolean;
}

export type ShadowJudgeWinner = "primary" | "candidate" | "tie";

export interface ShadowJudgeVerdict {
	primary_score: number;
	candidate_score: number;
	winner: ShadowJudgeWinner;
	reason?: string;
	candidate_shown_first: boolean;
}

/** Signal that decided Record.pass. */
export type ShadowPassBasis = "judge" | "semantic" | "structural" | "lexical";

/** One completed (or failed) shadow comparison. */
export interface ShadowRecord {
	id: string;
	request_id: string;
	experiment: string;
	created_at: string;
	stream: boolean;

	primary: ShadowModelRef;
	candidate: ShadowModelRef;

	prompt?: string;
	primary_answer?: ShadowAnswer;
	candidate_answer?: ShadowAnswer;

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

	comparison?: ShadowComparison;
	judge?: ShadowJudgeVerdict;
	judge_error?: string;

	pass: boolean;
	pass_basis?: ShadowPassBasis;
}

/** Outcome filter accepted by GET /api/shadow/records ("all" sends no filter). */
export type ShadowOutcomeFilter = "all" | "pass" | "fail" | "error";

export interface GetShadowRecordsParams {
	experiment?: string;
	/** "provider/model" */
	candidate?: string;
	outcome?: ShadowOutcomeFilter;
	limit?: number;
	offset?: number;
}

export interface GetShadowRecordsResponse {
	records: ShadowRecord[] | null;
	total: number;
}

export interface GetShadowCanaryRuleParams {
	experiment: string;
	/** "provider/model" */
	candidate: string;
	/** Share of traffic for the candidate, 0 < weight <= 1. */
	weight: number;
}

export interface ShadowRoutingTarget {
	provider: string;
	model: string;
	weight: number;
}

/** A ready-to-POST body for /api/routing/rules. */
export interface ShadowCanaryRule {
	name: string;
	description: string;
	enabled: boolean;
	cel_expression: string;
	targets: ShadowRoutingTarget[];
	scope: string;
	priority: number;
}

export interface ResetShadowRecordsResponse {
	message: string;
}