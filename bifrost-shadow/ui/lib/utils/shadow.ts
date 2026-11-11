/**
 * Pure helpers for the Shadow Traffic page: labels, formatting and query building.
 * Kept free of store and component imports so they can be unit tested directly.
 */

import { getLocale } from "@/lib/i18n";
import type { CreateRoutingRuleRequest, RoutingRule, RoutingTarget, UpdateRoutingRuleRequest } from "@/lib/types/routingRules";
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

/**
 * data-testid suffix for one experiment/candidate scorecard: two experiments may share a candidate,
 * so the experiment is part of it ("gpt-4o cost-down", "openai/gpt-4o-mini" -> "gpt-4o-cost-down--openai-gpt-4o-mini").
 * A slug never contains "--", so the double dash keeps the two parts apart.
 */
export function shadowPairTestIdSlug(pair: Pick<ShadowPairSummary, "experiment" | "candidate">): string {
	return `${shadowTestIdSlug(pair.experiment)}--${shadowTestIdSlug(shadowModelRefLabel(pair.candidate))}`;
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

/** Whether a value shows as zero once rounded to `fractionDigits` decimals, as Intl rounds it. */
function roundsToZero(value: number, fractionDigits: number): boolean {
	return Math.round(Math.abs(value) * 10 ** fractionDigits) === 0;
}

/** Formats a fraction (0.961) as a percentage ("96.1%"). */
export function formatShadowPercent(fraction: number, locale: string = getLocale(), maximumFractionDigits = 1): string {
	if (!Number.isFinite(fraction)) return "–";
	// Intl keeps the sign of a value that rounds to zero, and "-0%" reads as a loss.
	const value = roundsToZero(fraction, maximumFractionDigits + 2) ? 0 : fraction;
	return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits }).format(value);
}

/** Formats a value already expressed in percent (savings_pct = 97.3) as a percentage ("97.3%"). */
export function formatShadowPercentValue(percent: number, locale: string = getLocale(), maximumFractionDigits = 1): string {
	if (!Number.isFinite(percent)) return "–";
	return formatShadowPercent(percent / 100, locale, maximumFractionDigits);
}

export type ShadowSavingsTone = "positive" | "negative" | "neutral";

/**
 * Colour of a savings figure (savings_pct), judged on the value as shown: a figure that reads "0%"
 * stays neutral, which covers the 0 the plugin reports when the primary model has no pricing.
 */
export function shadowSavingsTone(savingsPct: number, maximumFractionDigits = 1): ShadowSavingsTone {
	if (!Number.isFinite(savingsPct) || roundsToZero(savingsPct, maximumFractionDigits)) return "neutral";
	return savingsPct > 0 ? "positive" : "negative";
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

/** Query string for GET /api/shadow/canary-rule. Without a priority the gateway uses its default. */
export function buildShadowCanaryRuleQueryParams(params: GetShadowCanaryRuleParams): Record<string, string | number> {
	const query: Record<string, string | number> = { experiment: params.experiment, candidate: params.candidate, weight: params.weight };
	if (params.priority !== undefined) query.priority = params.priority;
	return query;
}

/** Priority the gateway gives a canary rule when none is asked for. */
export const SHADOW_CANARY_BASE_PRIORITY = 10;

/** Lowest priority from the canary default up that no global routing rule holds; the store rejects two rules sharing one in a scope. */
export function shadowCanaryPriority(rules: Pick<RoutingRule, "scope" | "priority">[], base = SHADOW_CANARY_BASE_PRIORITY): number {
	const taken = new Set(rules.filter((rule) => rule.scope === "global").map((rule) => rule.priority));
	let priority = base;
	while (taken.has(priority)) priority++;
	return priority;
}

/** The rule an earlier promotion of the same pair created: the gateway names canaries per pair, and names are unique per scope. */
export function findShadowCanaryRule<T extends Pick<RoutingRule, "name" | "scope" | "scope_id">>(
	rules: T[],
	canary: Pick<ShadowCanaryRule, "name" | "scope">,
): T | undefined {
	return rules.find((rule) => rule.name === canary.name && rule.scope === canary.scope && !rule.scope_id);
}

/** Share of a rule's traffic that goes to the model (0 to 1). */
export function shadowCandidateShare(targets: Pick<RoutingTarget, "provider" | "model" | "weight">[], model: ShadowModelRef): number {
	return targets
		.filter((target) => (target.provider ?? "") === (model.provider ?? "") && target.model === model.model)
		.reduce((share, target) => share + target.weight, 0);
}

/** The existing canary as a ramp leaves it: the preview's split and description, on the rule's own condition, priority and state. */
export function shadowCanaryRampRule(
	existing: Pick<RoutingRule, "name" | "cel_expression" | "scope" | "priority" | "enabled">,
	preview: ShadowCanaryRule,
): ShadowCanaryRule {
	return {
		...preview,
		name: existing.name,
		cel_expression: existing.cel_expression,
		scope: existing.scope,
		priority: existing.priority,
		enabled: existing.enabled,
	};
}

/** Update body for ramping an existing canary: only the split and the description that states it change. */
export function shadowCanaryRuleToUpdateRequest(rule: ShadowCanaryRule): UpdateRoutingRuleRequest {
	return {
		description: rule.description,
		targets: rule.targets.map((target) => ({ provider: target.provider, model: target.model, weight: target.weight })),
	};
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