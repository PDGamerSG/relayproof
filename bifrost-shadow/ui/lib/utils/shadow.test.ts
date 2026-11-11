import type { RoutingRule } from "@/lib/types/routingRules";
import type { ShadowCanaryRule } from "@/lib/types/shadow";
import { describe, expect, it } from "vitest";
import {
	buildShadowCanaryRuleQueryParams,
	buildShadowRecordsQueryParams,
	canaryWeightFromPercent,
	findShadowCanaryRule,
	formatShadowMs,
	formatShadowNumber,
	formatShadowPercent,
	formatShadowPercentValue,
	formatShadowScore,
	formatShadowUsd,
	isShadowNotEnabledError,
	isShadowVerdict,
	isValidCanaryWeightPercent,
	shadowBudgetFraction,
	shadowCandidateShare,
	shadowCanaryPriority,
	shadowCanaryRampRule,
	shadowCanaryRuleToCreateRequest,
	shadowCanaryRuleToUpdateRequest,
	shadowJudgeScoreDelta,
	shadowModelRefLabel,
	shadowPairKey,
	shadowPairTestIdSlug,
	shadowSavingsTone,
	shadowTestIdSlug,
	shadowVerdictBadgeVariant,
} from "./shadow";

describe("shadowVerdictBadgeVariant", () => {
	it("maps each verdict to its colour", () => {
		expect(shadowVerdictBadgeVariant("ready")).toBe("success");
		expect(shadowVerdictBadgeVariant("promising")).toBe("warning");
		expect(shadowVerdictBadgeVariant("not_ready")).toBe("destructive");
		expect(shadowVerdictBadgeVariant("collecting")).toBe("secondary");
	});

	it("falls back to neutral for an unknown verdict", () => {
		expect(shadowVerdictBadgeVariant("something_new")).toBe("secondary");
	});

	it("recognises only the known verdicts", () => {
		expect(isShadowVerdict("ready")).toBe(true);
		expect(isShadowVerdict("not_ready")).toBe(true);
		expect(isShadowVerdict("unknown")).toBe(false);
		expect(isShadowVerdict(undefined)).toBe(false);
	});
});

describe("model labels and keys", () => {
	it("renders provider/model, or the bare model without a provider", () => {
		expect(shadowModelRefLabel({ provider: "openai", model: "gpt-4o-mini" })).toBe("openai/gpt-4o-mini");
		expect(shadowModelRefLabel({ model: "gpt-4o" })).toBe("gpt-4o");
		expect(shadowModelRefLabel({ provider: "", model: "*" })).toBe("*");
	});

	it("keys a pair by experiment and candidate", () => {
		const a = shadowPairKey({ experiment: "exp", candidate: { provider: "openai", model: "gpt-4o-mini" } });
		const b = shadowPairKey({ experiment: "exp", candidate: { provider: "openai", model: "llama-3.1-8b" } });
		const c = shadowPairKey({ experiment: "other", candidate: { provider: "openai", model: "gpt-4o-mini" } });
		expect(new Set([a, b, c]).size).toBe(3);
	});

	it("slugifies values for data-testid", () => {
		expect(shadowTestIdSlug("openai/gpt-4o-mini")).toBe("openai-gpt-4o-mini");
		expect(shadowTestIdSlug("openai/llama-3.1-8b")).toBe("openai-llama-3-1-8b");
		expect(shadowTestIdSlug("/Anthropic/Claude 3.5/")).toBe("anthropic-claude-3-5");
	});

	it("gives each experiment/candidate pair its own readable data-testid slug", () => {
		const mini = { provider: "openai", model: "gpt-4o-mini" };
		expect(shadowPairTestIdSlug({ experiment: "gpt-4o cost-down", candidate: mini })).toBe("gpt-4o-cost-down--openai-gpt-4o-mini");
		expect(shadowPairTestIdSlug({ experiment: "openai/gpt-4o vs openai/gpt-4o-mini", candidate: { model: "Llama 3.1" } })).toBe(
			"openai-gpt-4o-vs-openai-gpt-4o-mini--llama-3-1",
		);
		// Two experiments that shadow the same candidate must not produce duplicate ids.
		const slugs = [
			shadowPairTestIdSlug({ experiment: "gpt-4o cost-down", candidate: mini }),
			shadowPairTestIdSlug({ experiment: "claude cost-down", candidate: mini }),
			shadowPairTestIdSlug({ experiment: "gpt-4o cost-down", candidate: { provider: "openai", model: "llama-3.1-8b" } }),
		];
		expect(new Set(slugs).size).toBe(3);
	});
});

describe("formatting", () => {
	it("formats fractions as percentages", () => {
		expect(formatShadowPercent(0.9612903, "en")).toBe("96.1%");
		expect(formatShadowPercent(0, "en")).toBe("0%");
		expect(formatShadowPercent(1, "en")).toBe("100%");
		expect(formatShadowPercent(Number.NaN, "en")).toBe("–");
	});

	it("formats values already in percent", () => {
		expect(formatShadowPercentValue(97.285, "en")).toBe("97.3%");
		expect(formatShadowPercentValue(-12.5, "en")).toBe("-12.5%");
	});

	it("never shows a negative zero", () => {
		// A candidate a rounding error pricier than the primary is not a loss worth a minus sign.
		expect(formatShadowPercentValue(-0.0004, "en")).toBe("0%");
		expect(formatShadowPercent(-0.00001, "en")).toBe("0%");
		expect(formatShadowPercentValue(-0.06, "en")).toBe("-0.1%");
	});

	it("follows the locale", () => {
		expect(formatShadowPercent(0.5, "de")).toMatch(/^50\s?%$/);
		expect(formatShadowUsd(1234.5, "de")).toMatch(/1\.234,50\s?\$/);
	});

	it("keeps sub-cent costs readable", () => {
		expect(formatShadowUsd(0, "en")).toBe("$0.00");
		expect(formatShadowUsd(0.000302951, "en")).toBe("$0.0003");
		expect(formatShadowUsd(0.0000082248, "en")).toBe("$0.0000082");
		expect(formatShadowUsd(0.01158, "en")).toBe("$0.0116");
		expect(formatShadowUsd(0.5, "en")).toBe("$0.50");
		expect(formatShadowUsd(309.876, "en")).toBe("$309.88");
		expect(formatShadowUsd(-5, "en")).toBe("-$5.00");
		expect(formatShadowUsd(Number.POSITIVE_INFINITY, "en")).toBe("–");
	});

	it("formats latency in ms below a second and seconds above", () => {
		expect(formatShadowMs(882, "en")).toBe("882 ms");
		expect(formatShadowMs(1116, "en")).toBe("1.12 sec");
		expect(formatShadowMs(0, "en")).toBe("0 ms");
	});

	it("formats judge scores and counts", () => {
		expect(formatShadowScore(8.729032, "en")).toBe("8.7");
		expect(formatShadowScore(9, "en")).toBe("9");
		expect(formatShadowNumber(12345, "en")).toBe("12,345");
		expect(formatShadowNumber(0.123, "en", 2)).toBe("0.12");
	});
});

describe("shadowSavingsTone", () => {
	it("colours savings by their sign", () => {
		expect(shadowSavingsTone(12.5)).toBe("positive");
		expect(shadowSavingsTone(-3)).toBe("negative");
	});

	it("keeps a figure that shows as 0% neutral", () => {
		// 0 is what the plugin reports when the primary model has no pricing.
		expect(shadowSavingsTone(0)).toBe("neutral");
		expect(shadowSavingsTone(-0.0004)).toBe("neutral");
		expect(shadowSavingsTone(0.04)).toBe("neutral");
		expect(shadowSavingsTone(Number.NaN)).toBe("neutral");
	});
});

describe("shadowBudgetFraction", () => {
	it("treats a zero budget as unlimited", () => {
		expect(shadowBudgetFraction(3, 0)).toBeNull();
	});

	it("clamps spend to the budget", () => {
		expect(shadowBudgetFraction(1, 4)).toBe(0.25);
		expect(shadowBudgetFraction(9, 4)).toBe(1);
		expect(shadowBudgetFraction(0, 4)).toBe(0);
	});
});

describe("buildShadowRecordsQueryParams", () => {
	it("sends every filter that is set", () => {
		expect(
			buildShadowRecordsQueryParams({
				experiment: "gpt-4o cost-down",
				candidate: "openai/gpt-4o-mini",
				outcome: "fail",
				limit: 20,
				offset: 40,
			}),
		).toEqual({ experiment: "gpt-4o cost-down", candidate: "openai/gpt-4o-mini", outcome: "fail", limit: 20, offset: 40 });
	});

	it("omits the 'all' outcome, empty strings and a zero offset", () => {
		expect(buildShadowRecordsQueryParams({ experiment: "", candidate: "", outcome: "all", limit: 20, offset: 0 })).toEqual({ limit: 20 });
		expect(buildShadowRecordsQueryParams({})).toEqual({});
	});
});

describe("canary weight", () => {
	it("converts the dialog percentage to an API weight", () => {
		expect(canaryWeightFromPercent(10)).toBe(0.1);
		expect(canaryWeightFromPercent(1)).toBe(0.01);
		expect(canaryWeightFromPercent(100)).toBe(1);
		expect(canaryWeightFromPercent(33)).toBe(0.33);
	});

	it("accepts only whole percentages from 1 to 100", () => {
		expect(isValidCanaryWeightPercent(1)).toBe(true);
		expect(isValidCanaryWeightPercent(100)).toBe(true);
		expect(isValidCanaryWeightPercent(0)).toBe(false);
		expect(isValidCanaryWeightPercent(101)).toBe(false);
		expect(isValidCanaryWeightPercent(12.5)).toBe(false);
		expect(isValidCanaryWeightPercent(Number.NaN)).toBe(false);
	});

	it("builds the canary-rule query", () => {
		expect(buildShadowCanaryRuleQueryParams({ experiment: "exp", candidate: "openai/gpt-4o-mini", weight: 0.1 })).toEqual({
			experiment: "exp",
			candidate: "openai/gpt-4o-mini",
			weight: 0.1,
		});
		expect(buildShadowCanaryRuleQueryParams({ experiment: "exp", candidate: "openai/gpt-4o-mini", weight: 0.1, priority: 12 })).toEqual({
			experiment: "exp",
			candidate: "openai/gpt-4o-mini",
			weight: 0.1,
			priority: 12,
		});
	});
});

describe("canary rule placement", () => {
	const rule = (name: string, priority: number, scope: RoutingRule["scope"] = "global", scope_id?: string) => ({
		name,
		priority,
		scope,
		scope_id,
	});

	it("takes the lowest priority from 10 up that no global rule holds", () => {
		expect(shadowCanaryPriority([])).toBe(10);
		expect(shadowCanaryPriority([rule("a", 10), rule("b", 11), rule("c", 13)])).toBe(12);
		expect(shadowCanaryPriority([rule("a", 1), rule("b", 2)])).toBe(10);
	});

	it("ignores priorities held in other scopes", () => {
		expect(shadowCanaryPriority([rule("team rule", 10, "team", "team-1"), rule("vk rule", 11, "virtual_key", "vk-1")])).toBe(10);
	});

	it("finds an earlier canary for the pair by its name, in the global scope only", () => {
		const name = "Shadow canary: openai/gpt-4o -> openai/gpt-4o-mini";
		const rules = [rule("other", 10), rule(name, 14, "team", "team-1"), rule(name, 12)];
		expect(findShadowCanaryRule(rules, { name, scope: "global" })).toBe(rules[2]);
		expect(findShadowCanaryRule(rules, { name: "Shadow canary: openai/gpt-4o -> openai/o3-mini", scope: "global" })).toBeUndefined();
	});

	it("reads the share a rule sends to the candidate", () => {
		const targets = [
			{ provider: "openai", model: "gpt-4o", weight: 0.9 },
			{ provider: "openai", model: "gpt-4o-mini", weight: 0.1 },
		];
		expect(shadowCandidateShare(targets, { provider: "openai", model: "gpt-4o-mini" })).toBe(0.1);
		expect(shadowCandidateShare(targets, { provider: "anthropic", model: "gpt-4o-mini" })).toBe(0);
		expect(shadowCandidateShare([{ model: "llama-3", weight: 0.2 }], { provider: "", model: "llama-3" })).toBe(0.2);
	});
});

describe("ramping an existing canary", () => {
	const preview: ShadowCanaryRule = {
		name: "Shadow canary: openai/gpt-4o -> openai/gpt-4o-mini",
		description: "Created from shadow experiment. Sends 20% of openai/gpt-4o traffic to openai/gpt-4o-mini.",
		enabled: true,
		cel_expression: 'provider == "openai" && model == "gpt-4o"',
		targets: [
			{ provider: "openai", model: "gpt-4o", weight: 0.8 },
			{ provider: "openai", model: "gpt-4o-mini", weight: 0.2 },
		],
		scope: "global",
		priority: 11,
	};
	const existing = {
		name: preview.name,
		cel_expression: 'model == "gpt-4o"',
		scope: "global" as const,
		priority: 10,
		enabled: false,
	};

	it("shows the new split on the existing rule's condition, priority and state", () => {
		expect(shadowCanaryRampRule(existing, preview)).toEqual({
			...preview,
			cel_expression: existing.cel_expression,
			priority: 10,
			enabled: false,
		});
	});

	it("updates only the split and its description", () => {
		expect(shadowCanaryRuleToUpdateRequest(preview)).toEqual({ description: preview.description, targets: preview.targets });
	});
});

describe("shadowCanaryRuleToCreateRequest", () => {
	it("maps the server rule onto the routing rules create body", () => {
		const rule: ShadowCanaryRule = {
			name: "Shadow canary: openai/gpt-4o -> openai/gpt-4o-mini (10%)",
			description: "Created from shadow experiment.",
			enabled: true,
			cel_expression: 'provider == "openai" && model == "gpt-4o"',
			targets: [
				{ provider: "openai", model: "gpt-4o", weight: 0.9 },
				{ provider: "openai", model: "gpt-4o-mini", weight: 0.1 },
			],
			scope: "global",
			priority: 10,
		};
		expect(shadowCanaryRuleToCreateRequest(rule)).toEqual({
			name: rule.name,
			description: rule.description,
			enabled: true,
			cel_expression: rule.cel_expression,
			targets: rule.targets,
			scope: "global",
			priority: 10,
		});
	});
});

describe("isShadowNotEnabledError", () => {
	it("is true only for a 404", () => {
		expect(isShadowNotEnabledError({ status: 404, data: { error: { message: "shadow plugin is not enabled" } } })).toBe(true);
		expect(isShadowNotEnabledError({ status: 500 })).toBe(false);
		expect(isShadowNotEnabledError({ status: "FETCH_ERROR" })).toBe(false);
		expect(isShadowNotEnabledError(undefined)).toBe(false);
	});
});

describe("shadowJudgeScoreDelta", () => {
	it("is candidate minus primary, or null when nothing was judged", () => {
		expect(shadowJudgeScoreDelta({ avg_primary_score: 9, avg_candidate_score: 8.5, judged: 10 })).toBe(-0.5);
		expect(shadowJudgeScoreDelta({ avg_primary_score: 0, avg_candidate_score: 0, judged: 0 })).toBeNull();
	});
});