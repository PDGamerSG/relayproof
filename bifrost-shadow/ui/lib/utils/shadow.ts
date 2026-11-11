/**
 * Pure helpers for the Shadow Traffic page: labels, formatting and query building.
 * Kept free of store and component imports so they can be unit tested directly.
 */

import { getLocale } from "@/lib/i18n";
import type { CreateRoutingRuleRequest } from "@/lib/types/routingRules";
import type {
	GetShadowCanaryRuleParams,
	GetShadowRecordsParams,
	ShadowCanaryRule,
	ShadowModelRef,
	ShadowPairSummary,
	ShadowVerdict,
} from "@/lib/types/shadow";

export const SHADOW_VERDICTS: readonly ShadowVerdict[] = ["collecting", "ready", "promising", "not_ready"];

/** Default canary share offered by the promote dialog, in percent. */
export const DEFAULT_CANARY_WEIGHT_PERCENT = 10;

export type ShadowBadgeVariant = "success" | "warning" | "destructive" | "secondary";

/** Renders a model reference the way the gateway does: "provider/model", or the bare model when no provider is set. */
export function shadowModelRefLabel(ref: ShadowModelRef): string {
	return ref.provider ? `${ref.provider}/${ref.model}` : ref.model;
}

/** Stable key for one experiment/candidate scorecard. */
export function shadowPairKey(pair: Pick<ShadowPairSummary, "experiment" | "candidate">): string {
	return `${pair.experiment}::${shadowModelRefLabel(pair.candidate)}`;
}

/** Lowercase, dash-separated form of a value for use inside a data-testid ("openai/gpt-4o-mini" -> "openai-gpt-4o-mini"). */
export function shadowTestIdSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function isShadowVerdict(value: unknown): value is ShadowVerdict {
	return typeof value === "string" && (SHADOW_VERDICTS as readonly string[]).includes(value);
}

/** Badge colour for a readiness verdict: ready green, promising amber, not ready red, collecting neutral. */
export function shadowVerdictBadgeVariant(verdict: string): ShadowBadgeVariant {
	switch (verdict) {
		case "ready":
			return "success";
		case "promising":
			return "warning";
		case "not_ready":
			return "destructive";
		default:
			return "secondary";
	}
}

/** Formats a fraction (0.961) as a percentage ("96.1%"). */
export function formatShadowPercent(fraction: number, locale: string = getLocale(), maximumFractionDigits = 1): string {
	if (!Number.isFinite(fraction)) return "–";
	return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits }).format(fraction);
}

/** Formats a value already expressed in percent (savings_pct = 97.3) as a percentage ("97.3%"). */
export function formatShadowPercentValue(percent: number, locale: string = getLocale(), maximumFractionDigits = 1): string {
	if (!Number.isFinite(percent)) return "–";
	return formatShadowPercent(percent / 100, locale, maximumFractionDigits);
}

/**
 * Formats a USD amount. Per-request costs are fractions of a cent, so small values keep
 * two significant digits instead of rounding to "$0.00".
 */
export function formatShadowUsd(value: number, locale: string = getLocale()): string {
	if (!Number.isFinite(value)) return "–";
	const abs = Math.abs(value);
	const base = { style: "currency", currency: "USD" } as const;
	if (abs === 0) return new Intl.NumberFormat(locale, { ...base, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(0);
	if (abs < 0.01) return new Intl.NumberFormat(locale, { ...base, maximumSignificantDigits: 2 }).format(value);
	if (abs < 1) return new Intl.NumberFormat(locale, { ...base, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
	return new Intl.NumberFormat(locale, { ...base, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** Formats a latency: milliseconds below one second, seconds above. */
export function formatShadowMs(ms: number, locale: string = getLocale()): string {
	if (!Number.isFinite(ms)) return "–";
	if (Math.abs(ms) < 1000) {
		return new Intl.NumberFormat(locale, { style: "unit", unit: "millisecond", unitDisplay: "short", maximumFractionDigits: 0 }).format(ms);
	}
	return new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "short", maximumFractionDigits: 2 }).format(ms / 1000);
}

/** Formats a judge score on the 1-10 scale. */
export function formatShadowScore(score: number, locale: string = getLocale()): string {
	if (!Number.isFinite(score)) return "–";
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(score);
}

/** Formats a count or a plain decimal. */
export function formatShadowNumber(value: number, locale: string = getLocale(), maximumFractionDigits = 0): string {
	if (!Number.isFinite(value)) return "–";
	return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}

/** Share of the daily evaluation budget spent, clamped to [0, 1]; null when the budget is unlimited (0). */
export function shadowBudgetFraction(spendUsd: number, budgetUsd: number): number | null {
	if (!(budgetUsd > 0)) return null;
	if (!Number.isFinite(spendUsd) || spendUsd <= 0) return 0;
	return Math.min(spendUsd / budgetUsd, 1);
}

/** Query string for GET /api/shadow/records. Empty filters and "all" are omitted so the server applies no filter. */
export function buildShadowRecordsQueryParams(params: GetShadowRecordsParams): Record<string, string | number> {
	const query: Record<string, string | number> = {};
	if (params.experiment) query.experiment = params.experiment;
	if (params.candidate) query.candidate = params.candidate;
	if (params.outcome && params.outcome !== "all") query.outcome = params.outcome;
	if (params.limit !== undefined && params.limit > 0) query.limit = Math.floor(params.limit);
	if (params.offset !== undefined && params.offset > 0) query.offset = Math.floor(params.offset);
	return query;
}

/** Converts the dialog's percentage (1-100) to the API weight (0 < w <= 1), rounded like the server does. */
export function canaryWeightFromPercent(percent: number): number {
	return Math.round(percent * 100) / 10000;
}

/** Whether a promote dialog percentage is a whole number in 1..100. */
export function isValidCanaryWeightPercent(percent: number): boolean {
	return Number.isInteger(percent) && percent >= 1 && percent <= 100;
}

/** Query string for GET /api/shadow/canary-rule. */
export function buildShadowCanaryRuleQueryParams(params: GetShadowCanaryRuleParams): Record<string, string | number> {
	return { experiment: params.experiment, candidate: params.candidate, weight: params.weight };
}

/** Maps the server-built canary rule onto the routing rules create body. */
export function shadowCanaryRuleToCreateRequest(rule: ShadowCanaryRule): CreateRoutingRuleRequest {
	return {
		name: rule.name,
		description: rule.description,
		enabled: rule.enabled,
		cel_expression: rule.cel_expression,
		targets: rule.targets.map((target) => ({ provider: target.provider, model: target.model, weight: target.weight })),
		scope: rule.scope,
		priority: rule.priority,
	};
}

/** True when an RTK Query error is the 404 the shadow API returns while the plugin is not loaded. */
export function isShadowNotEnabledError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "status" in error && (error as { status: unknown }).status === 404;
}

/** Candidate minus primary average judge score; null when no pair was judged. */
export function shadowJudgeScoreDelta(
	pair: Pick<ShadowPairSummary, "avg_primary_score" | "avg_candidate_score" | "judged">,
): number | null {
	if (!(pair.judged > 0)) return null;
	return pair.avg_candidate_score - pair.avg_primary_score;
}