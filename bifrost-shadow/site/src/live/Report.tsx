import { useEffect, useMemo, useState } from "react";
import { VERDICT_LABEL } from "../lib/stats";
import { count, modelId, ms, pct, saveBlob, useConnection, type DemoStatus } from "./backend";
import { agreementSeries, candidateKey, comparisonsToClear, eventsFor, type RecordsState } from "./records";
import type { PairSummary, RolloutEvent, Rollouts, ShadowRecord, Summary } from "./shadowClient";
import { Trend } from "./Trend";
import "./report.css";

const BASIS_TEXT: Record<string, string> = {
  judge: "the judge",
  exact: "an exact match",
  semantic: "embedding similarity",
  lexical: "lexical overlap",
  tool_selection: "a different tool choice",
  json_schema: "a different JSON shape",
  tool_arguments: "different tool arguments",
  unscored: "no usable signal",
  structural: "structure",
};

const ACTION_TEXT: Record<RolloutEvent["action"], string> = {
  promote: "Promoted",
  rollback: "Rolled back by an operator",
  auto_rollback: "Rolled back by the canary guard",
};

const money = (v: number) => {
  const abs = Math.abs(v);
  const s = abs >= 1000 ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 }) : abs >= 1 ? abs.toFixed(2) : abs.toFixed(abs >= 0.01 ? 4 : 6);
  return `${v < 0 ? "-" : ""}$${s}`;
};

function duration(hours: number): string {
  if (!Number.isFinite(hours)) return "an unknown time";
  if (hours < 1) return `about ${Math.max(1, Math.round(hours * 60))} minutes`;
  if (hours < 48) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

interface Facts {
  pair: PairSummary;
  title: string;
  verdict: string;
  advice: string;
  monthlyNow: number;
  monthlyAfter: number;
  canaryShare: number;
  worst: ShadowRecord[];
  events: RolloutEvent[];
  ratePerHour?: number;
  more?: number;
}

function analyse(pair: PairSummary, summary: Summary, records: ShadowRecord[], rollouts: Rollouts | undefined, volume: number): Facts {
  const t = summary.thresholds;
  const key = candidateKey(pair);
  const mine = records.filter((r) => candidateKey(r) === key);
  const series = agreementSeries(records, key);
  const span = series.length > 1 ? (series[series.length - 1].at - series[0].at) / 3_600_000 : 0;
  const ratePerHour = span > 0 ? (series.length - 1) / span : undefined;
  const scored = pair.scored + pair.errors;
  const more = pair.verdict === "promising" || pair.verdict === "collecting" ? comparisonsToClear(pair.passes, scored, t.min_agreement) : undefined;
  const monthlyNow = volume * pair.avg_primary_cost_usd;
  const monthlyAfter = volume * pair.avg_candidate_cost_usd;
  const canaryShare = 0.1;

  let advice: string;
  switch (pair.verdict) {
    case "ready":
      advice = `Promote it to a ${pct(canaryShare, 0)} canary with the guard on, then raise the share while live health holds. Switching fully would save ${money(monthlyNow - monthlyAfter)} a month at ${count(volume)} requests.`;
      break;
    case "promising":
      advice =
        more !== undefined
          ? `Keep shadowing. About ${count(more)} more agreeing comparisons lift the lower bound to ${pct(t.min_agreement, 0)}${ratePerHour ? `, ${duration(more / ratePerHour)} at the current rate` : ""}.`
          : "Keep shadowing; the agreement rate is high but the evidence is still thin.";
      break;
    case "collecting":
      advice = `Too early to call: ${count(scored)} of the ${count(t.min_samples)} scored comparisons a verdict needs.`;
      break;
    default:
      advice =
        pair.error_rate > t.max_error_rate
          ? `Do not switch. The candidate failed ${pct(pair.error_rate)} of calls, above the ${pct(t.max_error_rate, 0)} budget.`
          : `Do not switch. It agreed with the primary on ${pct(pair.agreement_rate)} of requests, and even the optimistic reading stays below ${pct(t.min_agreement, 0)}. The failures below show where it falls short.`;
  }

  const worst = mine
    .filter((r) => !r.pass && (r.candidate_error || r.judge || r.pass_basis))
    .sort((a, b) => {
      const ga = a.judge ? a.judge.candidate_score - a.judge.primary_score : -11;
      const gb = b.judge ? b.judge.candidate_score - b.judge.primary_score : -11;
      return ga - gb;
    })
    .slice(0, 3);

  return {
    pair,
    title: `${pair.candidate.model} in place of ${pair.source.model}`,
    verdict: VERDICT_LABEL[pair.verdict],
    advice,
    monthlyNow,
    monthlyAfter,
    canaryShare,
    worst,
    events: eventsFor(rollouts?.events, pair.experiment, modelId(pair.candidate)),
    ratePerHour,
    more,
  };
}

function toMarkdown(f: Facts, summary: Summary, gateway: string, volume: number): string {
  const p = f.pair;
  const t = summary.thresholds;
  const lines = [
    `# Readiness report: ${f.title}`,
    "",
    `Gateway ${gateway}, experiment "${p.experiment}". Generated ${new Date().toISOString()} by RelayProof.`,
    "",
    `**Verdict: ${f.verdict}.** ${p.verdict_reason}.`,
    "",
    f.advice,
    "",
    "| Measure | Primary | Candidate |",
    "|---|---|---|",
    `| Model | \`${modelId(p.source)}\` | \`${modelId(p.candidate)}\` |`,
    `| Judge score, out of 10 | ${p.judged ? p.avg_primary_score.toFixed(1) : "–"} | ${p.judged ? p.avg_candidate_score.toFixed(1) : "–"} |`,
    `| Latency p50 / p95 | ${ms(p.primary_latency.p50_ms)} / ${ms(p.primary_latency.p95_ms)} | ${ms(p.candidate_latency.p50_ms)} / ${ms(p.candidate_latency.p95_ms)} |`,
    `| Cost per request | ${money(p.avg_primary_cost_usd)} | ${money(p.avg_candidate_cost_usd)} |`,
    `| Monthly cost at ${count(volume)} requests | ${money(f.monthlyNow)} | ${money(f.monthlyAfter)} |`,
    "",
    `- Agreement ${pct(p.agreement_rate)} over ${count(p.scored + p.errors)} comparisons; 95% Wilson lower bound ${pct(p.agreement_lower_bound)} (needs ${pct(t.min_agreement, 0)}).`,
    `- Candidate errors ${pct(p.error_rate)} (${count(p.errors)}); budget ${pct(t.max_error_rate, 0)}.`,
    `- Judge: candidate better ${count(p.judge_candidate_wins)}, tie ${count(p.judge_ties)}, primary better ${count(p.judge_candidate_losses)}; judge errors ${pct(p.judge_error_rate)}.`,
    p.tool_turns > 0 ? `- Tool turns ${count(p.tool_turns)}: same tool names ${pct(p.tool_name_match_rate)}, same calls ${pct(p.tool_call_match_rate)}.` : "",
    p.json_match_rate !== undefined ? `- JSON structure match ${pct(p.json_match_rate)}.` : "",
    `- Savings ${pct(p.savings_pct / 100)}, ${money(p.savings_per_million_usd)} per million requests.`,
  ].filter((l) => l !== "");
  if (f.worst.length) {
    lines.push("", "## Worst disagreements", "");
    for (const r of f.worst) {
      lines.push(
        `- **${r.prompt ?? "(prompt not stored)"}**`,
        `  - Primary: ${(r.primary_answer?.text ?? "").replace(/\s+/g, " ").slice(0, 240)}`,
        `  - Candidate: ${r.candidate_error ? `error: ${r.candidate_error}` : (r.candidate_answer?.text ?? "").replace(/\s+/g, " ").slice(0, 240)}`,
        r.judge ? `  - Judge ${r.judge.primary_score} vs ${r.judge.candidate_score}: ${r.judge.reason ?? ""}` : `  - Decided by ${BASIS_TEXT[r.pass_basis ?? ""] ?? r.pass_basis}`,
      );
    }
  }
  if (f.events.length) {
    lines.push("", "## Rollout history", "");
    for (const e of f.events) lines.push(`- ${e.at}: ${ACTION_TEXT[e.action]}${e.action === "promote" ? ` to ${pct(e.weight, 0)}` : ""}${e.reason ? `: ${e.reason}` : ""}`);
  }
  lines.push(
    "",
    "## Method",
    "",
    `Agreement is passes divided by scored comparisons plus candidate errors. A candidate is ready when the 95% Wilson lower bound of its agreement is at least ${pct(t.min_agreement, 0)} after ${t.min_samples} scored comparisons and its error rate is at most ${pct(t.max_error_rate, 0)}. ${summary.judge_model ? `The judge (${summary.judge_model}) scores both answers out of 10 in a random order; the candidate passes when it trails by at most ${t.quality_tolerance} point.` : ""} A different tool choice or JSON shape fails a pair whatever the judge says.`,
  );
  return lines.join("\n");
}

/**
 * The readiness report: one page per candidate that answers "can we switch?",
 * with the evidence behind the answer. It prints cleanly, and copies as
 * Markdown for a pull request or a chat thread.
 */
export function Report({
  data,
  summary,
  rollouts,
}: {
  data: RecordsState;
  summary?: Summary;
  rollouts?: Rollouts;
  status?: DemoStatus;
}) {
  const conn = useConnection();
  const pairs = summary?.pairs ?? [];
  const [chosen, setChosen] = useState<string>();
  const [volume, setVolume] = useState(1_000_000);
  const [copied, setCopied] = useState(false);

  // Default to the most promising candidate: ready first, then by lower bound.
  useEffect(() => {
    if (chosen && pairs.some((p) => candidateKey(p) === chosen)) return;
    const rank = (p: PairSummary) => (p.verdict === "ready" ? 2 : p.verdict === "promising" ? 1 : 0) + p.agreement_lower_bound;
    const best = [...pairs].sort((a, b) => rank(b) - rank(a))[0];
    if (best) setChosen(candidateKey(best));
  }, [pairs, chosen]);

  const pair = pairs.find((p) => candidateKey(p) === chosen);
  const facts = useMemo(
    () => (pair && summary ? analyse(pair, summary, data.records, rollouts, volume) : undefined),
    [pair, summary, data.records, rollouts, volume],
  );

  if (!summary) return <p className="wrap lv-section lv-empty">Loading the scorecards…</p>;
  if (!pair || !facts) {
    return (
      <section className="wrap lv-section">
        <h1 className="lv-h2">Readiness report</h1>
        <p className="lv-empty">No candidate has comparisons yet. A report appears once traffic has been shadowed and scored.</p>
      </section>
    );
  }

  const t = summary.thresholds;
  const gateway = conn.mode === "trial" ? "hosted demo" : conn.label;
  const markdown = () => toMarkdown(facts, summary, gateway, volume);
  const slug = `${pair.candidate.model}-vs-${pair.source.model}`.replace(/[^a-z0-9.-]+/gi, "-");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      saveBlob(new Blob([markdown()], { type: "text/markdown" }), `relayproof-${slug}.md`);
    }
  };

  return (
    <section className="wrap lv-section lv-rp" aria-labelledby="rp-h">
      <div className="lv-head lv-rp__intro">
        <h1 className="lv-h2" id="rp-h">
          Readiness report
        </h1>
        <p className="muted small">
          One page that answers &ldquo;can we switch?&rdquo; for a candidate, with the evidence behind the answer. Print it, save it as a PDF
          or paste it into a pull request.
        </p>
      </div>

      <form className="lv-rp__controls" onSubmit={(e) => e.preventDefault()}>
        <label>
          <span>Candidate</span>
          <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
            {pairs.map((p) => (
              <option key={candidateKey(p)} value={candidateKey(p)}>
                {p.candidate.model} ({VERDICT_LABEL[p.verdict].toLowerCase()})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Your requests a month</span>
          <input
            type="number"
            min={1000}
            step={1000}
            value={volume}
            onChange={(e) => setVolume(Math.max(0, Number(e.target.value) || 0))}
            inputMode="numeric"
          />
        </label>
        <div className="lv-rp__buttons">
          <button type="button" className="btn btn--small" onClick={() => window.print()}>
            Print or save as PDF
          </button>
          <button type="button" className="btn btn--ghost btn--small" onClick={copy}>
            {copied ? "Copied" : "Copy as Markdown"}
          </button>
        </div>
      </form>

      <article className="lv-rp__doc" data-verdict={pair.verdict}>
        <header className="lv-rp__mast">
          <p className="lv-rp__kicker">RelayProof readiness report</p>
          <h2 className="lv-rp__title">
            <span className="model">{pair.candidate.model}</span> in place of <span className="model">{pair.source.model}</span>
          </h2>
          <p className="small muted">
            Gateway {gateway}, experiment &ldquo;{pair.experiment}&rdquo;. Evidence from {new Date(pair.first_seen).toLocaleString()} to{" "}
            {new Date(pair.last_seen).toLocaleString()}. Generated {new Date().toLocaleString()}.
          </p>
        </header>

        <div className="lv-rp__verdict">
          <span className="verdict" data-verdict={pair.verdict}>
            {facts.verdict}
          </span>
          <p className="lv-rp__reason">{pair.verdict_reason}.</p>
          <p className="lv-rp__advice">{facts.advice}</p>
        </div>

        <dl className="lv-rp__facts num">
          <div>
            <dt>Agreement</dt>
            <dd>{pct(pair.agreement_rate)}</dd>
            <dd className="lv-rp__note">
              lower bound {pct(pair.agreement_lower_bound)}, needs {pct(t.min_agreement, 0)}
            </dd>
          </div>
          <div>
            <dt>Comparisons</dt>
            <dd>{count(pair.scored + pair.errors)}</dd>
            <dd className="lv-rp__note">{count(pair.unscored)} unscored, not counted</dd>
          </div>
          <div>
            <dt>Candidate errors</dt>
            <dd>{pct(pair.error_rate)}</dd>
            <dd className="lv-rp__note">budget {pct(t.max_error_rate, 0)}</dd>
          </div>
          <div>
            <dt>Judge, out of 10</dt>
            <dd>{pair.judged ? `${pair.avg_primary_score.toFixed(1)} vs ${pair.avg_candidate_score.toFixed(1)}` : "–"}</dd>
            <dd className="lv-rp__note">
              better {count(pair.judge_candidate_wins)}, tie {count(pair.judge_ties)}, worse {count(pair.judge_candidate_losses)}
            </dd>
          </div>
          <div>
            <dt>Latency p50</dt>
            <dd>
              {ms(pair.primary_latency.p50_ms)} to {ms(pair.candidate_latency.p50_ms)}
            </dd>
            <dd className="lv-rp__note">
              p95 {ms(pair.primary_latency.p95_ms)} to {ms(pair.candidate_latency.p95_ms)}
            </dd>
          </div>
          <div>
            <dt>Cost per request</dt>
            <dd>
              {money(pair.avg_primary_cost_usd)} to {money(pair.avg_candidate_cost_usd)}
            </dd>
            <dd className="lv-rp__note">{pct(pair.savings_pct / 100)} cheaper</dd>
          </div>
        </dl>

        <section className="lv-rp__block">
          <h3 className="lv-rp__h">At your volume</h3>
          <div className="lv-rp__money num">
            <p>
              <span>Today</span>
              <b>{money(facts.monthlyNow)}</b>
              <small>a month on {pair.source.model}</small>
            </p>
            <p>
              <span>Switched</span>
              <b>{money(facts.monthlyAfter)}</b>
              <small>a month on {pair.candidate.model}</small>
            </p>
            <p data-tone={facts.monthlyNow - facts.monthlyAfter >= 0 ? "good" : "bad"}>
              <span>Difference</span>
              <b>{money(facts.monthlyNow - facts.monthlyAfter)}</b>
              <small>
                a month; a {pct(facts.canaryShare, 0)} canary saves {money((facts.monthlyNow - facts.monthlyAfter) * facts.canaryShare)}
              </small>
            </p>
          </div>
          <p className="small muted">Per-request costs are the averages this gateway measured on the compared requests, at its configured prices.</p>
        </section>

        <section className="lv-rp__block">
          <h3 className="lv-rp__h">How the evidence built up</h3>
          <Trend data={data} pair={pair} minAgreement={t.min_agreement} events={rollouts?.events} height={200} />
          <p className="small muted">
            Decided by{" "}
            {Object.entries(pair.pass_basis_counts ?? {})
              .filter(([, n]) => (n ?? 0) > 0)
              .map(([b, n]) => `${BASIS_TEXT[b] ?? b} ${count(n)}`)
              .join(", ") || "nothing yet"}
            .{pair.tool_turns > 0 && <> Tool turns {count(pair.tool_turns)}: same calls {pct(pair.tool_call_match_rate)}.</>}
            {pair.json_match_rate !== undefined && <> JSON structure matched {pct(pair.json_match_rate)}.</>}
          </p>
        </section>

        <section className="lv-rp__block">
          <h3 className="lv-rp__h">Where it falls short</h3>
          {facts.worst.length === 0 ? (
            <p className="small muted">No failing comparisons among the loaded records.</p>
          ) : (
            <ol className="lv-rp__cases">
              {facts.worst.map((r) => (
                <li key={r.id}>
                  <p className="lv-rp__prompt">{r.prompt ?? "Prompt not stored."}</p>
                  <div className="lv-rp__pair">
                    <div>
                      <p className="lv-rp__who small">{r.primary.model}</p>
                      <p className="lv-rp__ans">{r.primary_answer?.text || r.primary_answer?.tool_calls?.map((c) => `${c.name}(${c.arguments})`).join("\n")}</p>
                    </div>
                    <div>
                      <p className="lv-rp__who small">{r.candidate.model}</p>
                      <p className="lv-rp__ans">
                        {r.candidate_error
                          ? `Error: ${r.candidate_error}`
                          : r.candidate_answer?.text || r.candidate_answer?.tool_calls?.map((c) => `${c.name}(${c.arguments})`).join("\n")}
                      </p>
                    </div>
                  </div>
                  <p className="small muted lv-rp__case-foot">
                    <a className="link lv-rp__open" href={`#comparisons/${r.id}`}>
                      Open this comparison
                    </a>
                    {r.judge ? (
                      <>
                        Judge {r.judge.primary_score} vs {r.judge.candidate_score}
                        {r.judge.reason ? <>: &ldquo;{r.judge.reason}&rdquo;</> : null}
                      </>
                    ) : (
                      <>Decided by {BASIS_TEXT[r.pass_basis ?? ""] ?? "a candidate error"}.</>
                    )}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>

        {facts.events.length > 0 && (
          <section className="lv-rp__block">
            <h3 className="lv-rp__h">Rollout history</h3>
            <ul className="lv-rp__events small">
              {facts.events.map((e) => (
                <li key={e.id}>
                  <b>{new Date(e.at).toLocaleString()}</b> {ACTION_TEXT[e.action]}
                  {e.action === "promote" && <> to {pct(e.weight, 0)}</>}
                  {e.reason && <>: {e.reason}</>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="lv-rp__block lv-rp__method small">
          <h3 className="lv-rp__h">Method</h3>
          <p>
            Agreement is passes divided by scored comparisons plus candidate errors. A candidate is ready when the 95% Wilson lower bound of
            its agreement is at least {pct(t.min_agreement, 0)} after {t.min_samples} scored comparisons and its error rate is at most{" "}
            {pct(t.max_error_rate, 0)}. The lower bound is what keeps a lucky streak from promoting a model: 20 out of 20 is only 83.9%.
            {summary.judge_model && (
              <>
                {" "}
                The judge, <span className="model">{summary.judge_model}</span>, scores both answers out of 10 in a random order; the candidate
                passes when it trails by at most {t.quality_tolerance} point. A different tool choice or JSON shape fails a pair whatever the
                judge says.
              </>
            )}
          </p>
        </section>
      </article>
    </section>
  );
}
