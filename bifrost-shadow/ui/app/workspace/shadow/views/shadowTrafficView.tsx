/**
 * Shadow Traffic View
 * Orchestrates the scorecard: polls the summary, and owns the disagreements sheet and promote dialog.
 */

import FullPageLoader from "@/components/fullPageLoader";
import { LoadErrorView } from "@/components/loadErrorView";
import PageTitle from "@/components/pageTitle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useGetShadowSummaryQuery } from "@/lib/store/apis/shadowApi";
import type { ShadowPairSummary } from "@/lib/types/shadow";
import { showLoadError } from "@/lib/utils/loadError";
import { isShadowNotEnabledError, shadowPairKey } from "@/lib/utils/shadow";
import { RbacOperation, RbacResource, useRbac } from "@enterprise/lib";
import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShadowCounterTiles } from "./shadowCounterTiles";
import { ShadowDisagreementsSheet } from "./shadowDisagreementsSheet";
import { ShadowHeader } from "./shadowHeader";
import { ShadowNotEnabledView } from "./shadowNotEnabledView";
import { ShadowPromoteDialog } from "./shadowPromoteDialog";
import { ShadowScorecard } from "./shadowScorecard";

const POLLING_INTERVAL = 5000;

export function ShadowTrafficView() {
	const { t } = useTranslation("models", { keyPrefix: "shadow" });
	const [live, setLive] = useState(true);
	const [disagreementsOpen, setDisagreementsOpen] = useState(false);
	const [disagreementsPair, setDisagreementsPair] = useState<ShadowPairSummary | null>(null);
	const [promoteOpen, setPromoteOpen] = useState(false);
	const [promoteKey, setPromoteKey] = useState<string | null>(null);

	const canPromote = useRbac(RbacResource.RoutingRules, RbacOperation.Create);
	const canUpdate = useRbac(RbacResource.RoutingRules, RbacOperation.Update);
	const canDelete = useRbac(RbacResource.RoutingRules, RbacOperation.Delete);
	const canViewPlugins = useRbac(RbacResource.Plugins, RbacOperation.View);

	// Polling also runs while the plugin is missing: the handler resolves the plugin per
	// request, so enabling it from the plugins page flips this page without a reload.
	const {
		data: summary,
		error,
		isLoading,
		isFetching,
		refetch,
	} = useGetShadowSummaryQuery(undefined, {
		pollingInterval: live ? POLLING_INTERVAL : 0,
		skipPollingIfUnfocused: true,
		refetchOnMountOrArgChange: true,
	});

	const pairs = summary?.pairs ?? [];
	// The dialog reads the latest poll, so a verdict that changes while it is open is reflected.
	const promotePair = promoteKey ? (pairs.find((pair) => shadowPairKey(pair) === promoteKey) ?? null) : null;
	const hasPromotePair = promotePair !== null;
	const notEnabled = isShadowNotEnabledError(error);

	// Radix reports only the closes it causes. When the dialog's pair drops out of the summary, or
	// the not-enabled view replaces the page, the open flags are cleared here; otherwise the dialog
	// and the sheet would pop back open on their own once the pair or the plugin returns.
	useEffect(() => {
		if (!hasPromotePair) setPromoteOpen(false);
	}, [hasPromotePair]);
	useEffect(() => {
		if (!notEnabled) return;
		setPromoteOpen(false);
		setDisagreementsOpen(false);
	}, [notEnabled]);

	// Every branch names the page, or the topbar falls back to the "Shadow" slug.
	if (isLoading) {
		return (
			<>
				<PageTitle title={t("title")} />
				<FullPageLoader />
			</>
		);
	}

	if (notEnabled) {
		return <ShadowNotEnabledView onRetry={() => void refetch()} isRetrying={isFetching} canViewPlugins={canViewPlugins} />;
	}

	if (showLoadError(error, summary) || !summary) {
		return (
			<>
				<PageTitle title={t("title")} />
				<LoadErrorView entity={t("entity")} error={error} onRetry={() => void refetch()} testId="shadow-load-error" />
			</>
		);
	}

	const handleViewDisagreements = (pair: ShadowPairSummary) => {
		setDisagreementsPair(pair);
		setDisagreementsOpen(true);
	};

	const handlePromote = (pair: ShadowPairSummary) => {
		setPromoteKey(shadowPairKey(pair));
		setPromoteOpen(true);
	};

	return (
		<div className="flex w-full flex-col gap-4" data-testid="shadow-traffic-view">
			<ShadowHeader
				live={live}
				onLiveChange={setLive}
				onRefresh={() => void refetch()}
				isFetching={isFetching}
				canReset={canUpdate || canDelete}
				startedAt={summary.started_at}
			/>

			{summary.budget_exhausted && (
				<Alert variant="warning" data-testid="shadow-budget-exhausted">
					<TriangleAlert />
					<AlertTitle>{t("budgetExhausted.title")}</AlertTitle>
					<AlertDescription>{t("budgetExhausted.description")}</AlertDescription>
				</Alert>
			)}

			<ShadowCounterTiles summary={summary} />

			<ShadowScorecard
				pairs={pairs}
				experiments={summary.experiments ?? []}
				thresholds={summary.thresholds}
				canPromote={canPromote}
				onViewDisagreements={handleViewDisagreements}
				onPromote={handlePromote}
			/>

			<ShadowDisagreementsSheet pair={disagreementsPair} open={disagreementsOpen} onOpenChange={setDisagreementsOpen} />
			{canPromote && <ShadowPromoteDialog pair={promotePair} open={promoteOpen && !!promotePair} onOpenChange={setPromoteOpen} />}
		</div>
	);
}