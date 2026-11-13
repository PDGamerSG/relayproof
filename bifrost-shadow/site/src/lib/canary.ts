/** The routing rule "Promote to canary" creates. Follows BuildCanaryRule in plugins/shadow/api.go. */

export interface CanaryRule {
  name: string;
  description: string;
  enabled: boolean;
  cel_expression: string;
  targets: { provider: string; model: string; weight: number }[];
  scope: string;
  priority: number;
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

function split(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf("/");
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

export function buildCanaryRule(experiment: string, source: string, candidate: string, sharePercent: number, priority = 10): CanaryRule {
  const from = split(source);
  const to = split(candidate);
  const share = round4(sharePercent / 100);
  return {
    name: `Shadow canary: ${source} -> ${candidate}`,
    description: `Created from shadow experiment "${experiment}". Sends ${round4(share * 100)}% of ${source} traffic to ${candidate}.`,
    enabled: true,
    cel_expression: `provider == "${from.provider}" && model == "${from.model}"`,
    targets: [
      { ...from, weight: round4(1 - share) },
      { ...to, weight: share },
    ],
    scope: "global",
    priority,
  };
}
