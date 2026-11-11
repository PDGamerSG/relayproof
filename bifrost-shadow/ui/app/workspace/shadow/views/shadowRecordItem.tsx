import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { getLocale } from "@/lib/i18n";
import type { ShadowAnswer, ShadowModelRef, ShadowRecord } from "@/lib/types/shadow";
import { cn } from "@/lib/utils";
import {
	formatShadowMs,
	formatShadowNumber,
	formatShadowPercent,
	formatShadowScore,
	formatShadowUsd,
	shadowModelRefLabel,
} from "@/lib/utils/shadow";
import { ChevronDown, CircleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

type Outcome = "pass" | "fail" | "error";

const outcomeOf = (record: ShadowRecord): Outcome => (record.candidate_error ? "error" : record.pass ? "pass" : "fail");

const outcomeBadgeVariant: Record<Outcome, "success" | "destructive" | "warning"> = {
	pass: "success",
	fail: "destructive",
	error: "warning",
};

export function ShadowRecordItem({ record }: { record: ShadowRecord }) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.records" });
	const [open, setOpen] = useState(false);
	const outcome = outcomeOf(record);

	return (
		<Collapsible open={open} onOpenChange={setOpen} className="rounded-sm border" data-testid={`shadow-record-${record.id}`}>
			<CollapsibleTrigger asChild>
				<button
					type="button"
					className="hover:bg-muted/50 flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left"
					aria-expanded={open}
					data-testid={`shadow-record-toggle-${record.id}`}
				>
					<ChevronDown className={cn("text-muted-foreground mt-0.5 h-4 w-4 shrink-0 transition-transform", open && "rotate-180")} />
					<div className="min-w-0 flex-1 space-y-1">
						<div className="flex flex-wrap items-center gap-2">
							<Badge variant={outcomeBadgeVariant[outcome]}>{t(`outcome.${outcome}`)}</Badge>
							{record.pass_basis && (
								<Badge variant="outline" className="font-normal">
									{t("basis", { basis: t(`passBasis.${record.pass_basis}`) })}
								</Badge>
							)}
							{record.stream && (
								<Badge variant="outline" className="font-normal">
									{t("stream")}
								</Badge>
							)}
							<span className="text-muted-foreground text-xs">{new Date(record.created_at).toLocaleString(getLocale())}</span>
						</div>
						<p className="line-clamp-2 text-sm">
							{record.prompt || <span className="text-muted-foreground italic">{t("promptNotStored")}</span>}
						</p>
					</div>
				</button>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<RecordDetails record={record} />
			</CollapsibleContent>
		</Collapsible>
	);
}

function RecordDetails({ record }: { record: ShadowRecord }) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.records" });

	return (
		<div className="space-y-4 border-t px-3 py-3" data-testid={`shadow-record-details-${record.id}`}>
			{record.prompt && (
				<div className="space-y-1">
					<div className="text-muted-foreground text-xs font-medium">{t("prompt")}</div>
					<pre className="bg-muted/50 max-h-60 overflow-auto rounded-sm border p-2 font-mono text-xs whitespace-pre-wrap">
						{record.prompt}
					</pre>
				</div>
			)}

			<div className="grid gap-3 md:grid-cols-2">
				<AnswerPanel
					title={t("primary")}
					model={record.primary}
					answer={record.primary_answer}
					latencyMs={record.primary_latency_ms}
					costUsd={record.primary_cost_usd}
					inputTokens={record.primary_input_tokens}
					outputTokens={record.primary_output_tokens}
					testId={`shadow-record-primary-${record.id}`}
				/>
				<AnswerPanel
					title={t("candidate")}
					model={record.candidate}
					answer={record.candidate_answer}
					latencyMs={record.candidate_latency_ms}
					costUsd={record.candidate_cost_usd}
					inputTokens={record.candidate_input_tokens}
					outputTokens={record.candidate_output_tokens}
					error={record.candidate_error}
					testId={`shadow-record-candidate-${record.id}`}
				/>
			</div>

			<JudgeSection record={record} />
			<ComparisonSection record={record} />

			<div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
				{record.pass_basis && <span>{t("passBasisLine", { basis: t(`passBasis.${record.pass_basis}`) })}</span>}
				{record.eval_cost_usd > 0 && <span>{t("evalCost", { cost: formatShadowUsd(record.eval_cost_usd) })}</span>}
				<span className="font-mono">{t("requestId", { id: record.request_id })}</span>
			</div>
		</div>
	);
}

interface AnswerPanelProps {
	title: string;
	model: ShadowModelRef;
	answer?: ShadowAnswer;
	latencyMs: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	error?: string;
	testId: string;
}

function AnswerPanel({ title, model, answer, latencyMs, costUsd, inputTokens, outputTokens, error, testId }: AnswerPanelProps) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.records" });
	const toolCalls = answer?.tool_calls ?? [];

	return (
		<div className="min-w-0 space-y-2 rounded-sm border p-3" data-testid={testId}>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<div className="min-w-0">
					<div className="text-muted-foreground text-[11px] tracking-wide uppercase">{title}</div>
					<div className="truncate font-mono text-xs font-medium">{shadowModelRefLabel(model)}</div>
				</div>
				<div className="text-muted-foreground flex flex-wrap gap-x-3 font-mono text-xs">
					<span>{formatShadowMs(latencyMs)}</span>
					<span>{formatShadowUsd(costUsd)}</span>
					<span>{t("tokens", { input: formatShadowNumber(inputTokens), output: formatShadowNumber(outputTokens) })}</span>
				</div>
			</div>

			{error && (
				<Alert variant="destructive" className="py-2">
					<CircleAlert />
					<AlertDescription className="font-mono text-xs break-all">{error}</AlertDescription>
				</Alert>
			)}

			{answer ? (
				<>
					{answer.text ? (
						<pre className="bg-muted/50 max-h-80 overflow-auto rounded-sm border p-2 font-mono text-xs whitespace-pre-wrap">
							{answer.text}
						</pre>
					) : (
						toolCalls.length === 0 && <p className="text-muted-foreground text-xs italic">{t("emptyText")}</p>
					)}
					{toolCalls.length > 0 && (
						<div className="space-y-1.5">
							<div className="text-muted-foreground text-xs font-medium">{t("toolCalls", { count: toolCalls.length })}</div>
							{toolCalls.map((call, index) => (
								// Tool calls have no ID in the comparison projection, and their order is the answer's order.
								<div key={`${call.name}-${index}`} className="space-y-1">
									<div className="font-mono text-xs font-medium">{call.name}</div>
									<pre className="bg-muted/50 max-h-48 overflow-auto rounded-sm border p-2 font-mono text-xs whitespace-pre-wrap">
										{call.arguments}
									</pre>
								</div>
							))}
						</div>
					)}
					{answer.finish_reason && (
						<div className="text-muted-foreground text-xs">{t("finishReason", { reason: answer.finish_reason })}</div>
					)}
				</>
			) : (
				!error && <p className="text-muted-foreground text-xs italic">{t("answerNotStored")}</p>
			)}
		</div>
	);
}

function JudgeSection({ record }: { record: ShadowRecord }) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.records" });
	const judge = record.judge;
	if (!judge && !record.judge_error) return null;

	return (
		<div className="space-y-1.5" data-testid={`shadow-record-judge-${record.id}`}>
			<div className="text-muted-foreground text-xs font-medium">{t("judge")}</div>
			{judge && (
				<div className="flex flex-wrap items-center gap-2 text-xs">
					<Badge variant="outline" className="font-mono font-normal">
						{t("judgeScores", { primary: formatShadowScore(judge.primary_score), candidate: formatShadowScore(judge.candidate_score) })}
					</Badge>
					<Badge variant={judge.winner === "candidate" ? "success" : judge.winner === "primary" ? "destructive" : "secondary"}>
						{t(`winner.${judge.winner}`)}
					</Badge>
					{judge.reason && <span className="text-muted-foreground">{judge.reason}</span>}
				</div>
			)}
			{judge && (
				<p className="text-muted-foreground text-xs" data-testid={`shadow-record-judge-order-${record.id}`}>
					{/* The judge's own reason names "response A"/"response B"; the order is randomized per pair. */}
					{t("judgeOrder", { label: judge.candidate_shown_first ? "A" : "B" })}
				</p>
			)}
			{record.judge_error && <p className="text-xs text-red-600 dark:text-red-400">{t("judgeError", { error: record.judge_error })}</p>}
		</div>
	);
}

function ComparisonSection({ record }: { record: ShadowRecord }) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.records" });
	const comparison = record.comparison;
	if (!comparison) return null;

	const yesNo = (value: boolean) => (value ? t("match") : t("mismatch"));
	const metrics = [
		{ key: "lexical", label: t("lexical"), value: formatShadowPercent(comparison.lexical_similarity) },
		comparison.semantic_similarity !== undefined && {
			key: "semantic",
			label: t("semantic"),
			value: formatShadowPercent(comparison.semantic_similarity),
		},
		{ key: "length", label: t("lengthRatio"), value: formatShadowNumber(comparison.length_ratio, undefined, 2) },
		comparison.tool_calls_match !== undefined && {
			key: "toolCalls",
			label: t("toolCallsMatch"),
			value: yesNo(comparison.tool_calls_match),
		},
		comparison.json_match !== undefined && { key: "json", label: t("jsonMatch"), value: yesNo(comparison.json_match) },
		{ key: "finish", label: t("finishReasonMatch"), value: yesNo(comparison.finish_reason_match) },
	].filter((metric): metric is { key: string; label: string; value: string } => Boolean(metric));

	return (
		<div className="space-y-1.5" data-testid={`shadow-record-comparison-${record.id}`}>
			<div className="text-muted-foreground text-xs font-medium">{t("similarity")}</div>
			<dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
				{metrics.map((metric) => (
					<div key={metric.key} className="flex items-center justify-between gap-2">
						<dt className="text-muted-foreground">{metric.label}</dt>
						<dd className="font-mono">{metric.value}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}