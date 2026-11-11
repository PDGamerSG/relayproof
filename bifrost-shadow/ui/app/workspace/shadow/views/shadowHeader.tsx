import PageTitle from "@/components/pageTitle";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alertDialog";
import { Button } from "@/components/ui/button";
import { getLocale } from "@/lib/i18n";
import { getErrorMessage } from "@/lib/store";
import { useResetShadowRecordsMutation } from "@/lib/store/apis/shadowApi";
import { Radio, RefreshCw, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

interface ShadowHeaderProps {
	live: boolean;
	onLiveChange: (live: boolean) => void;
	onRefresh: () => void;
	isFetching: boolean;
	canReset: boolean;
	/** When the plugin started collecting (RFC 3339); omitted before the first summary arrives. */
	startedAt?: string;
}

export function ShadowHeader({ live, onLiveChange, onRefresh, isFetching, canReset, startedAt }: ShadowHeaderProps) {
	const { t } = useTranslation("models", { keyPrefix: "shadow" });
	const { t: tc } = useTranslation("common");
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [resetRecords, { isLoading: isResetting }] = useResetShadowRecordsMutation();

	const startedLabel = startedAt ? new Date(startedAt).toLocaleString(getLocale()) : null;

	const handleReset = async () => {
		try {
			await resetRecords().unwrap();
			toast.success(t("reset.success"));
			setConfirmOpen(false);
		} catch (error) {
			toast.error(t("reset.failed"), { description: getErrorMessage(error) });
		}
	};

	return (
		<>
			{/* The title and the longer explanation are portalled into the topbar. */}
			<PageTitle title={t("title")}>{t("pageInfo")}</PageTitle>
			<div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
				<div className="min-w-0 space-y-1">
					<p className="text-sm">{t("description")}</p>
					{startedLabel && <p className="text-muted-foreground text-xs">{t("collectingSince", { date: startedLabel })}</p>}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{/* Live mode refetches on its own; a manual refresh is only offered while paused. */}
					{!live && (
						<Button
							variant="outline"
							size="sm"
							onClick={onRefresh}
							disabled={isFetching}
							aria-label={t("refresh")}
							data-testid="shadow-refresh-button"
						>
							<RefreshCw className={isFetching ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
							<span className="hidden sm:inline">{t("refresh")}</span>
						</Button>
					)}
					{/* A toggle keeps one name, which starts with its visible "Live" label; aria-pressed carries
					    the state, so the "Paused" tag is for sighted users only. */}
					<Button
						variant={live ? "default" : "outline"}
						size="sm"
						onClick={() => onLiveChange(!live)}
						aria-pressed={live}
						aria-label={t("liveUpdates")}
						data-testid="shadow-live-toggle"
					>
						<Radio className={live ? "h-4 w-4 animate-pulse" : "h-4 w-4"} />
						{t("live")}
						{!live && <span className="text-muted-foreground border-l pl-2 font-normal">{t("paused")}</span>}
					</Button>
					{canReset && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setConfirmOpen(true)}
							disabled={isResetting}
							aria-label={t("reset.button")}
							data-testid="shadow-reset-button"
						>
							<RotateCcw className="h-4 w-4" />
							<span className="hidden sm:inline">{t("reset.button")}</span>
						</Button>
					)}
				</div>
			</div>

			<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("reset.title")}</AlertDialogTitle>
						<AlertDialogDescription>{t("reset.description")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isResetting} data-testid="shadow-reset-cancel-button">
							{tc("cancel")}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={(event) => {
								// Keep the dialog open until the request settles so a failure stays in context.
								event.preventDefault();
								void handleReset();
							}}
							disabled={isResetting}
							className="bg-destructive hover:bg-destructive/90 text-white"
							data-testid="shadow-reset-confirm-button"
						>
							{t("reset.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}