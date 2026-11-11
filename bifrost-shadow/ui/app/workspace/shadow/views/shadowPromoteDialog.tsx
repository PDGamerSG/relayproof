import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/useDebounce";
import { getErrorMessage } from "@/lib/store";
import { useCreateRoutingRuleMutation } from "@/lib/store/apis/routingRulesApi";
import { useGetShadowCanaryRuleQuery, useLazyGetShadowCanaryRuleQuery } from "@/lib/store/apis/shadowApi";
import { shadowCanaryFormSchema, type ShadowCanaryFormSchema } from "@/lib/types/schemas";
import type { ShadowCanaryRule, ShadowPairSummary } from "@/lib/types/shadow";
import { cn } from "@/lib/utils";
import { getScopeLabel } from "@/lib/utils/labels";
import {
	canaryWeightFromPercent,
	DEFAULT_CANARY_WEIGHT_PERCENT,
	formatShadowPercent,
	isShadowVerdict,
	isValidCanaryWeightPercent,
	shadowCanaryRuleToCreateRequest,
	shadowModelRefLabel,
} from "@/lib/utils/shadow";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, Rocket, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface ShadowPromoteDialogProps {
	pair: ShadowPairSummary | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ShadowPromoteDialog({ pair, open, onOpenChange }: ShadowPromoteDialogProps) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.promote" });
	const { t: tv } = useTranslation("models", { keyPrefix: "shadow.verdict" });
	const { t: tc } = useTranslation("common");
	const navigate = useNavigate();
	const [submitError, setSubmitError] = useState<string | null>(null);

	const experiment = pair?.experiment ?? "";
	const candidate = pair ? shadowModelRefLabel(pair.candidate) : "";

	const {
		register,
		handleSubmit,
		reset,
		control,
		formState: { errors, isSubmitting },
	} = useForm<ShadowCanaryFormSchema>({
		resolver: zodResolver(shadowCanaryFormSchema),
		mode: "onChange",
		defaultValues: { weight_percent: DEFAULT_CANARY_WEIGHT_PERCENT },
	});

	// Every opening starts from the default share, for whichever pair was picked.
	useEffect(() => {
		if (!open) return;
		reset({ weight_percent: DEFAULT_CANARY_WEIGHT_PERCENT });
		setSubmitError(null);
	}, [open, experiment, candidate, reset]);

	const weightPercent = useWatch({ control, name: "weight_percent" });
	const previewPercent: number = useDebouncedValue(weightPercent, 300);
	const previewValid = isValidCanaryWeightPercent(previewPercent);

	const {
		data: preview,
		error: previewError,
		isFetching: previewFetching,
	} = useGetShadowCanaryRuleQuery(
		{ experiment, candidate, weight: canaryWeightFromPercent(previewPercent) },
		{ skip: !open || !pair || !previewValid },
	);

	const [fetchCanaryRule] = useLazyGetShadowCanaryRuleQuery();
	const [createRoutingRule] = useCreateRoutingRuleMutation();

	const onSubmit = async (values: ShadowCanaryFormSchema) => {
		if (!pair) return;
		setSubmitError(null);
		try {
			// Rebuilt for the submitted share so the rule never lags the debounced preview.
			const rule = await fetchCanaryRule({ experiment, candidate, weight: canaryWeightFromPercent(values.weight_percent) }).unwrap();
			const created = await createRoutingRule(shadowCanaryRuleToCreateRequest(rule)).unwrap();
			toast.success(t("success", { name: created.name }), {
				description: t("successDescription"),
				action: {
					label: t("viewRules"),
					onClick: () => void navigate({ to: "/workspace/routing-rules" }),
				},
			});
			onOpenChange(false);
		} catch (error) {
			setSubmitError(getErrorMessage(error));
		}
	};

	const verdictLabel = pair ? (isShadowVerdict(pair.verdict) ? tv(pair.verdict) : pair.verdict) : "";
	const previewMatchesInput = previewPercent === weightPercent;
	const canConfirm = !!pair && previewValid && previewMatchesInput && !!preview && !previewError && !previewFetching && !isSubmitting;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl" data-testid="shadow-promote-dialog">
				<form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
					<DialogHeader>
						<DialogTitle>{t("title")}</DialogTitle>
						{pair && <DialogDescription>{t("description", { source: shadowModelRefLabel(pair.source), candidate })}</DialogDescription>}
					</DialogHeader>

					{pair && pair.verdict !== "ready" && (
						<Alert variant="warning" data-testid="shadow-promote-caution">
							<TriangleAlert />
							<AlertTitle>{t("cautionTitle", { verdict: verdictLabel })}</AlertTitle>
							<AlertDescription>
								<p>{t("caution")}</p>
								{pair.verdict_reason && <p className="mt-1 text-xs">{pair.verdict_reason}</p>}
							</AlertDescription>
						</Alert>
					)}

					<div className="space-y-2">
						<Label htmlFor="shadow-promote-weight">{t("weightLabel")}</Label>
						<div className="flex items-center gap-2">
							<Input
								id="shadow-promote-weight"
								type="number"
								min={1}
								max={100}
								step={1}
								inputMode="numeric"
								className={cn("w-28 font-mono", errors.weight_percent && "border-destructive focus-visible:ring-destructive")}
								aria-invalid={errors.weight_percent ? true : undefined}
								aria-describedby="shadow-promote-weight-help"
								data-testid="shadow-promote-weight-input"
								{...register("weight_percent", { valueAsNumber: true })}
							/>
							<span className="text-muted-foreground text-sm">%</span>
						</div>
						{errors.weight_percent ? (
							<p id="shadow-promote-weight-help" className="text-destructive text-xs" data-testid="shadow-promote-weight-error">
								{errors.weight_percent.message}
							</p>
						) : (
							<p id="shadow-promote-weight-help" className="text-muted-foreground text-xs">
								{t("weightHelp")}
							</p>
						)}
					</div>

					<RulePreview rule={preview} loading={previewFetching || (previewValid && !previewMatchesInput)} error={previewError} />

					{submitError && (
						<Alert variant="destructive" data-testid="shadow-promote-error">
							<CircleAlert />
							<AlertTitle>{t("failed")}</AlertTitle>
							<AlertDescription>{submitError}</AlertDescription>
						</Alert>
					)}

					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)} data-testid="shadow-promote-cancel-button">
							{tc("cancel")}
						</Button>
						<Button type="submit" disabled={!canConfirm} isLoading={isSubmitting} data-testid="shadow-promote-confirm-button">
							<Rocket className="h-4 w-4" />
							{t("confirm")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function RulePreview({ rule, loading, error }: { rule?: ShadowCanaryRule; loading: boolean; error: unknown }) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.promote" });

	if (error && !loading) {
		return (
			<Alert variant="destructive" data-testid="shadow-promote-preview-error">
				<CircleAlert />
				<AlertTitle>{t("previewFailed")}</AlertTitle>
				<AlertDescription>{getErrorMessage(error)}</AlertDescription>
			</Alert>
		);
	}

	if (!rule) {
		return loading ? <Skeleton className="h-36 w-full" /> : null;
	}

	return (
		<div className={cn("space-y-3 rounded-sm border p-3 transition-opacity", loading && "opacity-60")} data-testid="shadow-promote-preview">
			<div className="text-muted-foreground text-xs font-medium">{t("previewTitle")}</div>
			<div className="space-y-0.5">
				<div className="text-sm font-medium" data-testid="shadow-promote-preview-name">
					{rule.name}
				</div>
				{rule.description && <p className="text-muted-foreground text-xs">{rule.description}</p>}
			</div>
			<div className="space-y-1">
				<div className="text-muted-foreground text-xs">{t("celExpression")}</div>
				<code className="bg-muted/50 block w-full rounded-sm border px-2 py-1.5 font-mono text-xs break-all">{rule.cel_expression}</code>
			</div>
			<div className="space-y-1.5">
				<div className="text-muted-foreground text-xs">{t("targets")}</div>
				{rule.targets.map((target) => {
					const label = target.provider ? `${target.provider}/${target.model}` : target.model;
					return (
						<div key={label} className="flex items-center justify-between gap-3">
							<span className="truncate font-mono text-xs">{label}</span>
							<div className="flex shrink-0 items-center gap-2">
								<div className="bg-muted h-1.5 w-20 overflow-hidden rounded-full" aria-hidden>
									<div className="bg-primary h-full rounded-full" style={{ width: `${Math.round(target.weight * 100)}%` }} />
								</div>
								<span className="w-12 text-right font-mono text-xs">{formatShadowPercent(target.weight)}</span>
							</div>
						</div>
					);
				})}
			</div>
			<div className="flex flex-wrap gap-2">
				<Badge variant="secondary">{t("scope", { scope: getScopeLabel(rule.scope) })}</Badge>
				<Badge variant="secondary">{t("priority", { priority: rule.priority })}</Badge>
				<Badge variant={rule.enabled ? "default" : "secondary"}>{rule.enabled ? t("enabled") : t("disabled")}</Badge>
			</div>
		</div>
	);
}