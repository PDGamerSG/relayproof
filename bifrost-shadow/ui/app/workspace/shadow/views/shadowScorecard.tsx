import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ShadowExperiment, ShadowPairSummary, ShadowThresholds } from "@/lib/types/shadow";
import { cn } from "@/lib/utils";
import {
	formatShadowMs,
	formatShadowNumber,
	formatShadowPercent,
	formatShadowPercentValue,
	formatShadowScore,
	formatShadowUsd,
	isShadowVerdict,
	shadowModelRefLabel,
	shadowPairKey,
	shadowPairTestIdSlug,
	shadowSavingsTone,
	shadowVerdictBadgeVariant,
	type ShadowSavingsTone,
} from "@/lib/utils/shadow";
import { ArrowRight, FlaskConical, MessageSquareDiff, Rocket } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

const SAVINGS_TONE_CLASS: Record<ShadowSavingsTone, string> = {
	positive: "text-green-700 dark:text-green-400",
	negative: "text-red-600 dark:text-red-400",
	neutral: "text-muted-foreground",
};

interface ShadowScorecardProps {
	pairs: ShadowPairSummary[];
	experiments: ShadowExperiment[];
	thresholds: ShadowThresholds;
	canPromote: boolean;
	onViewDisagreements: (pair: ShadowPairSummary) => void;
	onPromote: (pair: ShadowPairSummary) => void;
}

export function ShadowScorecard({ pairs, experiments, thresholds, canPromote, onViewDisagreements, onPromote }: ShadowScorecardProps) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.scorecard" });

	return (
		<section className="space-y-3" data-testid="shadow-scorecard">
			<div>
				<h2 className="text-sm font-semibold">{t("title")}</h2>
				<p className="text-muted-foreground text-xs">{t("subtitle")}</p>
			</div>
			{pairs.length === 0 ? (
				<ScorecardEmptyState experiments={experiments} />
			) : (
				<div className="space-y-3">
					{pairs.map((pair) => (
						<PairCard
							key={shadowPairKey(pair)}
							pair={pair}
							minSamples={thresholds.min_samples}
							canPromote={canPromote}
							onViewDisagreements={onViewDisagreements}
							onPromote={onPromote}
						/>
					))}
				</div>
			)}
		</section>
	);
}

function ScorecardEmptyState({ experiments }: { experiments: ShadowExperiment[] }) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.scorecard" });
	return (
		<Card className="items-center gap-3 px-6 py-10 text-center shadow-none" data-testid="shadow-scorecard-empty">
			<FlaskConical className="text-muted-foreground h-8 w-8" strokeWidth={1.5} />
			<div className="space-y-1">
				<p className="text-sm font-medium">{t("emptyTitle")}</p>
				<p className="text-muted-foreground max-w-lg text-sm">{t("emptyDescription")}</p>
			</div>
			{experiments.length > 0 && (
				<ul className="text-muted-foreground space-y-1 text-xs">
					{experiments.map((experiment) => (
						<li key={experiment.name ?? shadowModelRefLabel(experiment.source)} className="font-mono">
							{t("experimentLine", {
								name: experiment.name ?? shadowModelRefLabel(experiment.source),
								source: shadowModelRefLabel(experiment.source),
								candidates: experiment.candidates.map(shadowModelRefLabel).join(", "),
							})}
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}

function VerdictBadge({ pair }: { pair: ShadowPairSummary }) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.verdict" });
	const label = isShadowVerdict(pair.verdict) ? t(pair.verdict) : pair.verdict;
	const badge = (
		<Badge variant={shadowVerdictBadgeVariant(pair.verdict)} data-testid={`shadow-verdict-${shadowPairTestIdSlug(pair)}`}>
			{label}
		</Badge>
	);
	if (!pair.verdict_reason) return badge;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="cursor-default">{badge}</span>
			</TooltipTrigger>
			<TooltipContent className="max-w-80">{pair.verdict_reason}</TooltipContent>
		</Tooltip>
	);
}

function Metric({ label, value, detail, className }: { label: string; value: ReactNode; detail?: ReactNode; className?: string }) {
	return (
		<div className={cn("min-w-0 space-y-0.5", className)}>
			<dt className="text-muted-foreground text-[11px] tracking-wide uppercase">{label}</dt>
			<dd className="truncate font-mono text-sm font-medium">{value}</dd>
			{detail && <dd className="text-muted-foreground text-xs break-words">{detail}</dd>}
		</div>
	);
}

interface PairCardProps {
	pair: ShadowPairSummary;
	minSamples?: number;
	canPromote: boolean;
	onViewDisagreements: (pair: ShadowPairSummary) => void;
	onPromote: (pair: ShadowPairSummary) => void;
}

function PairCard({ pair, minSamples, canPromote, onViewDisagreements, onPromote }: PairCardProps) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.scorecard" });
	const candidateLabel = shadowModelRefLabel(pair.candidate);
	const sourceLabel = shadowModelRefLabel(pair.source);
	const slug = shadowPairTestIdSlug(pair);
	// A wildcard source covers several concrete primaries; name them so the operator knows what was compared.
	const primaryModels = pair.primary_models ?? [];
	const showPrimaryModels = primaryModels.length > 0 && !(primaryModels.length === 1 && primaryModels[0] === sourceLabel);
	const savingsTone = shadowSavingsTone(pair.savings_pct);

	const extraSignals = [
		{ key: "lexical", label: t("lexical"), value: pair.avg_lexical_similarity },
		{ key: "semantic", label: t("semantic"), value: pair.avg_semantic_similarity },
		{ key: "toolCalls", label: t("toolCalls"), value: pair.tool_call_match_rate },
		{ key: "json", label: t("json"), value: pair.json_match_rate },
	].filter((signal): signal is { key: string; label: string; value: number } => typeof signal.value === "number");

	return (
		<Card className="gap-4 px-4 py-4 shadow-none" data-testid={`shadow-pair-row-${slug}`}>
			<div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
				<div className="min-w-0 space-y-1">
					<div className="text-muted-foreground text-xs">{pair.experiment}</div>
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-mono text-sm">{sourceLabel}</span>
						<ArrowRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-label={t("toCandidate")} />
						<span className="font-mono text-sm font-semibold">{candidateLabel}</span>
						<VerdictBadge pair={pair} />
					</div>
					{pair.verdict_reason && <p className="text-muted-foreground text-xs">{pair.verdict_reason}</p>}
					{showPrimaryModels && <p className="text-muted-foreground text-xs">{t("primaryModels", { models: primaryModels.join(", ") })}</p>}
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-2">
					<Button variant="outline" size="sm" onClick={() => onViewDisagreements(pair)} data-testid={`shadow-disagreements-button-${slug}`}>
						<MessageSquareDiff className="h-4 w-4" />
						{t("viewDisagreements")}
					</Button>
					{canPromote && (
						<Button
							variant={pair.verdict === "ready" ? "default" : "outline"}
							size="sm"
							onClick={() => onPromote(pair)}
							data-testid={`shadow-promote-button-${slug}`}
						>
							<Rocket className="h-4 w-4" />
							{t("promote")}
						</Button>
					)}
				</div>
			</div>

			<dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-7">
				<Metric
					label={t("samples")}
					value={formatShadowNumber(pair.samples)}
					detail={
						pair.verdict === "collecting" && minSamples
							? t("samplesNeeded", { count: minSamples, formatted: formatShadowNumber(minSamples) })
							: t("judgedCount", { count: pair.judged, formatted: formatShadowNumber(pair.judged) })
					}
				/>
				<Metric
					label={t("agreement")}
					value={formatShadowPercent(pair.agreement_rate)}
					detail={t("lowerBound", { value: formatShadowPercent(pair.agreement_lower_bound) })}
				/>
				<Metric
					label={t("errorRate")}
					value={formatShadowPercent(pair.error_rate)}
					detail={t("errorsOfSamples", { errors: formatShadowNumber(pair.errors), samples: formatShadowNumber(pair.samples) })}
				/>
				<Metric
					label={t("judgeScore")}
					value={
						pair.judged > 0
							? t("scoreVs", { primary: formatShadowScore(pair.avg_primary_score), candidate: formatShadowScore(pair.avg_candidate_score) })
							: "–"
					}
					detail={
						pair.judged > 0
							? t("judgeRecord", {
									wins: formatShadowNumber(pair.judge_candidate_wins),
									ties: formatShadowNumber(pair.judge_ties),
									losses: formatShadowNumber(pair.judge_candidate_losses),
								})
							: t("notJudged")
					}
				/>
				<Metric
					label={t("latencyP50")}
					value={t("latencyVs", {
						primary: formatShadowMs(pair.primary_latency.p50_ms),
						candidate: formatShadowMs(pair.candidate_latency.p50_ms),
					})}
					detail={t("primaryVsCandidate")}
				/>
				<Metric
					label={t("latencyP95")}
					value={t("latencyVs", {
						primary: formatShadowMs(pair.primary_latency.p95_ms),
						candidate: formatShadowMs(pair.candidate_latency.p95_ms),
					})}
					detail={t("primaryVsCandidate")}
				/>
				<Metric
					label={t("savings")}
					value={<span className={SAVINGS_TONE_CLASS[savingsTone]}>{formatShadowPercentValue(pair.savings_pct)}</span>}
					detail={t("projectedMonthly", { amount: formatShadowUsd(pair.projected_monthly_savings_usd) })}
				/>
			</dl>

			{extraSignals.length > 0 && (
				<div className="flex flex-wrap items-center gap-2">
					{extraSignals.map((signal) => (
						<Badge key={signal.key} variant="outline" className="font-normal">
							{t("signal", { label: signal.label, value: formatShadowPercent(signal.value) })}
						</Badge>
					))}
					<span className="text-muted-foreground text-xs">
						{t("costPerRequest", {
							primary: formatShadowUsd(pair.avg_primary_cost_usd),
							candidate: formatShadowUsd(pair.avg_candidate_cost_usd),
						})}
					</span>
				</div>
			)}
		</Card>
	);
}