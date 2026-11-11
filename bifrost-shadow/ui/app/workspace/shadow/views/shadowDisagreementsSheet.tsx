import { LoadErrorView } from "@/components/loadErrorView";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useGetShadowRecordsQuery } from "@/lib/store/apis/shadowApi";
import type { ShadowOutcomeFilter, ShadowPairSummary } from "@/lib/types/shadow";
import { showLoadError } from "@/lib/utils/loadError";
import { formatShadowNumber, shadowModelRefLabel } from "@/lib/utils/shadow";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShadowRecordItem } from "./shadowRecordItem";

const PAGE_SIZE = 20;
const OUTCOME_FILTERS: readonly ShadowOutcomeFilter[] = ["fail", "error", "pass", "all"];

interface ShadowDisagreementsSheetProps {
	pair: ShadowPairSummary | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ShadowDisagreementsSheet({ pair, open, onOpenChange }: ShadowDisagreementsSheetProps) {
	const { t } = useTranslation("models", { keyPrefix: "shadow.records" });
	const { t: tc } = useTranslation("common");
	const [outcome, setOutcome] = useState<ShadowOutcomeFilter>("fail");
	const [offset, setOffset] = useState(0);

	const candidate = pair ? shadowModelRefLabel(pair.candidate) : "";
	const experiment = pair?.experiment ?? "";

	// Each pair opens on its disagreements, first page.
	useEffect(() => {
		setOutcome("fail");
		setOffset(0);
	}, [experiment, candidate]);

	const { data, error, isLoading, isFetching, refetch } = useGetShadowRecordsQuery(
		{ experiment, candidate, outcome, limit: PAGE_SIZE, offset },
		{ skip: !open || !pair, refetchOnMountOrArgChange: true },
	);

	const records = data?.records ?? [];
	const total = data?.total ?? 0;
	const from = total === 0 ? 0 : offset + 1;
	const to = Math.min(offset + records.length, total);

	// A reset or a shrinking filter can leave the offset past the end; step back to the last page.
	useEffect(() => {
		if (!data || offset === 0 || offset < total) return;
		setOffset(total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
	}, [data, offset, total]);

	const handleOutcomeChange = (value: string) => {
		setOutcome(value as ShadowOutcomeFilter);
		setOffset(0);
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="flex w-full flex-col p-4 sm:max-w-4xl md:p-6" data-testid="shadow-disagreements-sheet">
				<SheetHeader className="mb-2 p-0">
					<div className="flex min-w-0 flex-col gap-1">
						<SheetTitle className="text-base">{t("title")}</SheetTitle>
						{pair && (
							<SheetDescription className="truncate font-mono text-xs">
								{t("pairLine", { experiment: pair.experiment, source: shadowModelRefLabel(pair.source), candidate })}
							</SheetDescription>
						)}
					</div>
				</SheetHeader>

				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<Select value={outcome} onValueChange={handleOutcomeChange}>
							<SelectTrigger size="sm" className="w-44" aria-label={t("outcomeFilter")} data-testid="shadow-outcome-filter">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{OUTCOME_FILTERS.map((value) => (
									<SelectItem key={value} value={value} data-testid={`shadow-outcome-option-${value}`}>
										{t(`filter.${value}`)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							variant="outline"
							size="sm"
							onClick={() => void refetch()}
							disabled={isFetching || !pair}
							aria-label={t("refresh")}
							data-testid="shadow-records-refresh-button"
						>
							<RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
						</Button>
					</div>
					<span className="text-muted-foreground text-xs" data-testid="shadow-records-total">
						{t("total", { count: total, formatted: formatShadowNumber(total) })}
					</span>
				</div>

				<div className="-mx-4 mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto px-4 md:-mx-6 md:px-6">
					{showLoadError(error, data) ? (
						<LoadErrorView entity={t("entity")} error={error} onRetry={() => void refetch()} testId="shadow-records-load-error" />
					) : isLoading ? (
						<div className="space-y-2">
							<Skeleton className="h-16 w-full" />
							<Skeleton className="h-16 w-full" />
							<Skeleton className="h-16 w-full" />
						</div>
					) : records.length === 0 ? (
						<p className="text-muted-foreground py-12 text-center text-sm" data-testid="shadow-records-empty">
							{outcome === "fail" ? t("emptyFail") : t("empty")}
						</p>
					) : (
						records.map((record) => <ShadowRecordItem key={record.id} record={record} />)
					)}
				</div>

				{total > PAGE_SIZE && (
					<div className="flex items-center justify-between gap-2 border-t pt-3">
						<span className="text-muted-foreground text-xs">
							{t("range", { from: formatShadowNumber(from), to: formatShadowNumber(to), total: formatShadowNumber(total) })}
						</span>
						<div className="flex items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
								disabled={offset === 0 || isFetching}
								data-testid="shadow-records-prev-button"
							>
								<ChevronLeft className="h-4 w-4" />
								{tc("prev")}
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setOffset(offset + PAGE_SIZE)}
								disabled={offset + PAGE_SIZE >= total || isFetching}
								data-testid="shadow-records-next-button"
							>
								{tc("next")}
								<ChevronRight className="h-4 w-4" />
							</Button>
						</div>
					</div>
				)}
			</SheetContent>
		</Sheet>
	);
}