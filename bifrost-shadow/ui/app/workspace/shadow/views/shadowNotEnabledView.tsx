import PageTitle from "@/components/pageTitle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Link } from "@tanstack/react-router";
import { FlaskConical, Plug, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

// Minimal plugin entry for config.json. Field names and model names are config, not prose.
const SHADOW_CONFIG_SNIPPET = JSON.stringify(
	{
		plugins: [
			{
				enabled: true,
				name: "shadow",
				config: {
					sample_rate: 0.1,
					experiments: [
						{
							source: { provider: "openai", model: "gpt-4o" },
							candidates: [{ provider: "openai", model: "gpt-4o-mini" }],
						},
					],
					judge: { provider: "openai", model: "gpt-4o" },
				},
			},
		],
	},
	null,
	2,
);

interface ShadowNotEnabledViewProps {
	onRetry: () => void;
	isRetrying: boolean;
	canViewPlugins: boolean;
}

export function ShadowNotEnabledView({ onRetry, isRetrying, canViewPlugins }: ShadowNotEnabledViewProps) {
	const { t } = useTranslation("models", { keyPrefix: "shadow" });

	return (
		<>
			<PageTitle title={t("title")} />
			<Card className="mx-auto w-full max-w-3xl gap-5 px-6 py-8 shadow-none" data-testid="shadow-not-enabled">
				<div className="flex items-start gap-3">
					<FlaskConical className="text-muted-foreground mt-0.5 h-6 w-6 shrink-0" strokeWidth={1.5} />
					<div className="space-y-2">
						<h2 className="text-base font-semibold">{t("notEnabled.title")}</h2>
						<p className="text-muted-foreground text-sm">{t("notEnabled.description")}</p>
						<p className="text-muted-foreground text-sm">{t("notEnabled.promote")}</p>
					</div>
				</div>
				<div className="space-y-2">
					<p className="text-sm">{t("notEnabled.configHint")}</p>
					<pre
						className="bg-muted/50 overflow-x-auto rounded-sm border p-3 font-mono text-xs whitespace-pre-wrap"
						data-testid="shadow-config-snippet"
					>
						{SHADOW_CONFIG_SNIPPET}
					</pre>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button variant="outline" size="sm" onClick={onRetry} disabled={isRetrying} data-testid="shadow-not-enabled-retry-button">
						<RefreshCw className={isRetrying ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
						{t("notEnabled.checkAgain")}
					</Button>
					{canViewPlugins && (
						<Button variant="outline" size="sm" asChild>
							<Link to="/workspace/plugins" data-testid="shadow-not-enabled-plugins-link">
								<Plug className="h-4 w-4" />
								{t("notEnabled.openPlugins")}
							</Link>
						</Button>
					)}
				</div>
			</Card>
		</>
	);
}