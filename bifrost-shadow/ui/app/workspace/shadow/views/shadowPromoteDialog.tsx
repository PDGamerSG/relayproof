import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/useDebounce";
import { getErrorMessage } from "@/lib/store";
import { useCreateRoutingRuleMutation, useGetRoutingRulesQuery, useUpdateRoutingRuleMutation } from "@/lib/store/apis/routingRulesApi";
import { useGetShadowCanaryRuleQuery } from "@/lib/store/apis/shadowApi";
import type { RoutingRule } from "@/lib/types/routingRules";
import { shadowCanaryFormSchema, type ShadowCanaryFormSchema } from "@/lib/types/schemas";
import type { ShadowCanaryRule, ShadowPairSummary } from "@/lib/types/shadow";
import { cn } from "@/lib/utils";
import { getScopeLabel } from "@/lib/utils/labels";
import {
	canaryWeightFromPercent,
	DEFAULT_CANARY_WEIGHT_PERCENT,
	findShadowCanaryRule,
	formatShadowPercent,
	isShadowVerdict,
	isValidCanaryWeightPercent,
	SHADOW_CANARY_BASE_PRIORITY,
	shadowCandidateShare,
	shadowCanaryPriority,
	shadowCanaryRampRule,
	shadowCanaryRuleToCreateRequest,
	shadowCanaryRuleToUpdateRequest,
	shadowModelRefLabel,
	shadowPairKey,
} from "@/lib/utils/shadow";
import { zodResolver } from "@hookform/resolvers/zod";
import { useNavigate } from "@tanstack/react-router";
import { CircleAlert, Info, Rocket, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface ShadowPromoteDialogProps {
	pair: ShadowPairSummary | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ShadowPromoteDialog({ pair, open, onOpenChange }: ShadowPromoteDialogProps) {
	const [submitting, setSubmitting] = useState(false);

	// While a create or update is in flight, Escape and the close button do nothing: the result
	// belongs on this dialog, not on one that has gone.
	const handleOpenChange = (next: boolean) => {
		if (!next && submitting) return;
		onOpenChange(next);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="sm:max-w-xl" data-testid="shadow-promote-dialog">
				{/* Radix mounts the content on each opening, so the form, the rules list and the preview
				    start fresh every time and hold still while the dialog animates closed. */}
				{pair && (
					<PromoteForm
						key={shadowPairKey(pair)}
						pair={pair}
						open={open}
						onSubmittingChange={setSubmitting}
						onClose={() => onOpenChange(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

interface PromoteFormProps {
	pair: ShadowPairSummary;
	open: boolean;
	onSubmittingChange: (submitting: boolean) => void;
	onClose: () => void;
}

function PromoteForm({ pair, open, onSubmittingChange, onClose }: PromoteFormProps) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.promote" });
	const { t: tv } = useTranslation("models", { keyPrefix: "shadow.verdict" });
	const { t: tc } = useTranslation("common");
	const navigate = useNavigate();
	const [submitError, setSubmitError] = useState<string | null>(null);
	// The rules list a confirm was decided on. The mutations patch the cached list, which would
	// otherwise turn the canary just created into an "update" while the dialog animates closed.
	const [heldRules, setHeldRules] = useState<RoutingRule[] | null>(null);

	const experiment = pair.experiment;
	const candidate = shadowModelRefLabel(pair.candidate);

	const {
		register,
		handleSubmit,
		control,
		formState: { errors, isSubmitting },
	} = useForm<ShadowCanaryFormSchema>({
		resolver: zodResolver(shadowCanaryFormSchema),
		mode: "onChange",
		defaultValues: { weight_percent: DEFAULT_CANARY_WEIGHT_PERCENT },
	});

	useEffect(() => {
		onSubmittingChange(isSubmitting);
		return () => onSubmittingChange(false);
	}, [isSubmitting, onSubmittingChange]);

	// The form is keyed by pair, so this says whether the dialog the request was sent from is still
	// showing. If it closed (its pair left the summary), the result goes to a toast instead.
	const shownRef = useRef(open);
	useEffect(() => {
		shownRef.current = open;
		return () => {
			shownRef.current = false;
		};
	}, [open]);

	const {
		currentData: rulesData,
		error: rulesError,
		isFetching: rulesFetching,
		refetch: refetchRules,
	} = useGetRoutingRulesQuery(undefined, { refetchOnMountOrArgChange: true });
	const rules = heldRules ?? (rulesData ? (rulesData.rules ?? []) : undefined);
	const priority = rules ? shadowCanaryPriority(rules) : undefined;

	const weightPercent = useWatch({ control, name: "weight_percent" });
	const previewPercent: number = useDebouncedValue(weightPercent, 300);
	const previewValid = isValidCanaryWeightPercent(previewPercent);
	const previewMatchesInput = previewPercent === weightPercent;

	// data keeps the last preview on screen, dimmed, while the next share loads; only currentData,
	// the preview for exactly these arguments, is ever applied.
	const {
		data: shownPreview,
		currentData: preview,
		error: previewError,
		isFetching: previewFetching,
	} = useGetShadowCanaryRuleQuery(
		{ experiment, candidate, weight: canaryWeightFromPercent(previewPercent), priority: priority ?? SHADOW_CANARY_BASE_PRIORITY },
		// A wildcard source's rule follows live traffic, so an opening never reuses a cached one.
		{ skip: !previewValid || priority === undefined, refetchOnMountOrArgChange: true },
	);

	const [createRoutingRule] = useCreateRoutingRuleMutation();
	const [updateRoutingRule] = useUpdateRoutingRuleMutation();

	// A canary for this pair already exists: confirming ramps it to the new share instead of adding a duplicate.
	const existing = shownPreview && rules ? findShadowCanaryRule(rules, shownPreview) : undefined;
	const shownRule = shownPreview && existing ? shadowCanaryRampRule(existing, shownPreview) : shownPreview;
	const rulesReady = rules !== undefined && (heldRules !== null || (!rulesFetching && !rulesError));
	const confirmable = rulesReady && previewValid && previewMatchesInput && !previewFetching && !previewError && preview !== undefined;
	// What confirming applies: the displayed preview for the share in the field, never a rule rebuilt
	// on submit (for a wildcard source the gateway may pick another primary on every call).
	const appliedRule = confirmable ? (existing ? shadowCanaryRampRule(existing, preview) : preview) : undefined;
	const canConfirm = !!appliedRule && !isSubmitting;

	const onSubmit = async () => {
		if (!appliedRule || !rules) return;
		const target = existing;
		const rule = appliedRule;
		setSubmitError(null);
		setHeldRules(rules);
		const viewRules = { label: t("viewRules"), onClick: () => void navigate({ to: "/workspace/routing-rules" }) };
		try {
			if (target) {
				const updated = await updateRoutingRule({ id: target.id, data: shadowCanaryRuleToUpdateRequest(rule) }).unwrap();
				toast.success(t("updated", { name: updated.name }), { description: t("updatedDescription"), action: viewRules });
			} else {
				const created = await createRoutingRule(shadowCanaryRuleToCreateRequest(rule)).unwrap();
				toast.success(t("success", { name: created.name }), { description: t("successDescription"), action: viewRules });
			}
			if (shownRef.current) onClose();
		} catch (error) {
			// Someone may have taken the priority or the name meanwhile; re-read before the next try.
			setHeldRules(null);
			void refetchRules();
			if (shownRef.current) setSubmitError(getErrorMessage(error));
			else toast.error(target ? t("updateFailed") : t("failed"), { description: getErrorMessage(error) });
		}
	};

	const verdictLabel = isShadowVerdict(pair.verdict) ? tv(pair.verdict) : pair.verdict;
	const source = shadowModelRefLabel(pair.source);
	const previewLoading = rules === undefined || previewFetching || (previewValid && !previewMatchesInput);

	return (
		<form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
			<DialogHeader>
				<DialogTitle>{existing ? t("titleUpdate") : t("title")}</DialogTitle>
				<DialogDescription>
					{existing ? t("descriptionUpdate", { source, candidate }) : t("description", { source, candidate })}
				</DialogDescription>
			</DialogHeader>

			{pair.verdict !== "ready" && (
				<Alert variant="warning" data-testid="shadow-promote-caution">
					<TriangleAlert />
					<AlertTitle>{t("cautionTitle", { verdict: verdictLabel })}</AlertTitle>
					<AlertDescription>
						<p>{t("caution")}</p>
						{pair.verdict_reason && <p className="mt-1 text-xs">{pair.verdict_reason}</p>}
					</AlertDescription>
				</Alert>
			)}

			{existing && (
				<Alert data-testid="shadow-promote-existing">
					<Info />
					<AlertTitle>{t("existingTitle")}</AlertTitle>
					<AlertDescription>
						{t("existingDescription", {
							name: existing.name,
							share: formatShadowPercent(shadowCandidateShare(existing.targets, pair.candidate)),
						})}
					</AlertDescription>
				</Alert>
			)}

			<fieldset disabled={isSubmitting} className="min-w-0 space-y-2">
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
			</fieldset>

			{rulesError && !heldRules ? (
				<Alert variant="destructive" data-testid="shadow-promote-rules-error">
					<CircleAlert />
					<AlertTitle>{t("rulesFailed")}</AlertTitle>
					<AlertDescription>{getErrorMessage(rulesError)}</AlertDescription>
				</Alert>
			) : (
				<RulePreview rule={shownRule} loading={previewLoading} stale={!appliedRule} error={previewError} />
			)}

			{submitError && (
				<Alert variant="destructive" data-testid="shadow-promote-error">
					<CircleAlert />
					<AlertTitle>{existing ? t("updateFailed") : t("failed")}</AlertTitle>
					<AlertDescription>{submitError}</AlertDescription>
				</Alert>
			)}

			<DialogFooter>
				<Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting} data-testid="shadow-promote-cancel-button">
					{tc("cancel")}
				</Button>
				<Button type="submit" disabled={!canConfirm} isLoading={isSubmitting} data-testid="shadow-promote-confirm-button">
					<Rocket className="h-4 w-4" />
					{existing ? t("confirmUpdate") : t("confirm")}
				</Button>
			</DialogFooter>
		</form>
	);
}

interface RulePreviewProps {
	rule?: ShadowCanaryRule;
	/** Nothing to show yet: a skeleton stands in. */
	loading: boolean;
	/** The rule shown is not the one confirming would apply (yet), so it is dimmed. */
	stale: boolean;
	error: unknown;
}

function RulePreview({ rule, loading, stale, error }: RulePreviewProps) {
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
		<div className={cn("space-y-3 rounded-sm border p-3 transition-opacity", stale && "opacity-60")} data-testid="shadow-promote-preview">
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
				<Badge variant="secondary" data-testid="shadow-promote-preview-priority">
					{t("priority", { priority: rule.priority })}
				</Badge>
				<Badge variant={rule.enabled ? "default" : "secondary"}>{rule.enabled ? t("enabled") : t("disabled")}</Badge>
			</div>
		</div>
	);
}