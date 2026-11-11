import { MetricSegment, MetricStripCard, MetricTrailing } from "@/components/metricStrip";
import type { ShadowSummary } from "@/lib/types/shadow";
import { formatShadowNumber, formatShadowPercent, formatShadowUsd, shadowBudgetFraction } from "@/lib/utils/shadow";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface ShadowCounterTilesProps {
	summary: ShadowSummary;
	loading?: boolean;
}

export function ShadowCounterTiles({ summary, loading }: ShadowCounterTilesProps) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.tiles" });
	const { counters } = summary;
	const errorRate = counters.completed > 0 ? counters.candidate_errors / counters.completed : 0;
	const budgetFraction = shadowBudgetFraction(summary.spend_today_usd, summary.daily_budget_usd);

	return (
		<MetricStripCard className="grid-cols-2 md:grid-cols-3 xl:grid-cols-6" loading={loading} testId="shadow-counter-tiles">
			<MetricSegment
				title={t("sampled")}
				testId="shadow-tile-sampled"
				footer={
					<MetricTrailing className="text-muted-foreground">
						{t("sampledFooter", {
							eligible: formatShadowNumber(counters.eligible),
							rate: formatShadowPercent(summary.sample_rate),
						})}
					</MetricTrailing>
				}
			>
				{formatShadowNumber(counters.sampled)}
			</MetricSegment>

			<MetricSegment
				title={t("compared")}
				testId="shadow-tile-compared"
				footer={
					<MetricTrailing className="text-muted-foreground">
						{t("comparedFooter", {
							inFlight: formatShadowNumber(counters.in_flight),
							queued: formatShadowNumber(counters.queue_depth),
						})}
					</MetricTrailing>
				}
			>
				{formatShadowNumber(counters.completed)}
			</MetricSegment>

			<MetricSegment
				title={t("candidateErrors")}
				testId="shadow-tile-candidate-errors"
				footer={
					<MetricTrailing className={counters.candidate_errors > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}>
						{t("candidateErrorsFooter", { rate: formatShadowPercent(errorRate) })}
					</MetricTrailing>
				}
			>
				{formatShadowNumber(counters.candidate_errors)}
			</MetricSegment>

			<MetricSegment
				title={t("dropped")}
				testId="shadow-tile-dropped"
				footer={
					<MetricTrailing className="text-muted-foreground">
						{t("droppedFooter", { skipped: formatShadowNumber(counters.budget_skipped) })}
					</MetricTrailing>
				}
			>
				{formatShadowNumber(counters.dropped)}
			</MetricSegment>

			<MetricSegment
				title={t("evalSpend")}
				testId="shadow-tile-eval-spend"
				footer={
					summary.budget_exhausted ? (
						<MetricTrailing className="text-red-600 dark:text-red-400" testId="shadow-tile-budget-exhausted">
							{t("budgetExhaustedShort")}
						</MetricTrailing>
					) : budgetFraction === null ? (
						<MetricTrailing className="text-muted-foreground">{t("budgetUnlimited")}</MetricTrailing>
					) : (
						<>
							<div className="bg-muted h-1.5 w-12 shrink-0 overflow-hidden rounded-full" aria-hidden>
								<div
									className={cn("h-full rounded-full", budgetFraction >= 0.9 ? "bg-amber-500" : "bg-primary")}
									style={{ width: `${Math.round(budgetFraction * 100)}%` }}
								/>
							</div>
							<MetricTrailing className="text-muted-foreground">
								{t("budgetOf", { budget: formatShadowUsd(summary.daily_budget_usd) })}
							</MetricTrailing>
						</>
					)
				}
			>
				{formatShadowUsd(summary.spend_today_usd)}
			</MetricSegment>

			<MetricSegment
				title={t("judge")}
				testId="shadow-tile-evaluators"
				footer={
					<MetricTrailing className="text-muted-foreground">
						{summary.embedding_model ? t("embeddingModel", { model: summary.embedding_model }) : t("embeddingOff")}
					</MetricTrailing>
				}
			>
				<span className="text-sm sm:text-base" title={summary.judge_model}>
					{summary.judge_model || t("judgeOff")}
				</span>
			</MetricSegment>
		</MetricStripCard>
	);
}