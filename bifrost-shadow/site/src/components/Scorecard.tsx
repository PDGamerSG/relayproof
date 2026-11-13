import { useState, type CSSProperties } from "react";
import { CANDIDATES, DISAGREEMENTS, EXPERIMENT, SOURCE, type Candidate, type Disagreement } from "../data/demo";
import { buildCanaryRule } from "../lib/canary";
import { pct, VERDICT_LABEL } from "../lib/stats";
import { Dialog } from "./Dialog";
import "./Scorecard.css";

/** Interval bar axis: 40% to 100%. */
function axis(fraction: number): string {
  return `${(((Math.min(1, Math.max(0.4, fraction)) - 0.4) / 0.6) * 100).toFixed(2)}%`;
}

function Record({ record, candidate }: { record: Disagreement; candidate: Candidate }) {
  return (
    <article className="rec">
      <header className="rec__head">
        <span className="verdict" data-verdict="not_ready">
          {record.basis === "error" ? "Error" : "Fail"}
        </span>
        <span className="rec__kind">{record.kind}</span>
        <span className="rec__basis">{record.basis === "error" ? "Candidate failed" : "Decided by the judge"}</span>
      </header>

      <p className="rec__prompt">{record.prompt}</p>

      <div className="rec__pair">
        <div className="rec__answer">
          <p className="rec__who">
            Primary <span className="model">{SOURCE}</span>
          </p>
          <p className="rec__text">{record.primary.text}</p>
          {record.primary.meta && <p className="rec__meta num">{record.primary.meta}</p>}
        </div>
        <div className="rec__answer" data-side="candidate">
          <p className="rec__who">
            Candidate <span className="model">{candidate.model}</span>
          </p>
          <p className="rec__text">{record.candidate.text}</p>
          {record.candidate.meta && <p className="rec__meta num">{record.candidate.meta}</p>}
        </div>
      </div>

      <div className="rec__judge">
        {record.scores && (
          <p className="rec__scores num">
            Primary <b>{record.scores.primary}</b>, candidate <b>{record.scores.candidate}</b>
          </p>
        )}
        <p className="rec__reason">
          {record.basis === "judge" ? <>Judge: &ldquo;{record.reason}&rdquo;</> : record.reason}
          {record.shownAs && <span> The candidate was shown to the judge as response {record.shownAs}.</span>}
        </p>
      </div>

      <dl className="rec__metrics num">
        {record.metrics.map((m) => (
          <div key={m.label}>
            <dt>{m.label}</dt>
            <dd>{m.value}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

function PromoteForm({ candidate, current, onCreate }: { candidate: Candidate; current: number | null; onCreate: (share: number) => void }) {
  const [share, setShare] = useState(current ?? 10);
  const rule = buildCanaryRule(EXPERIMENT, SOURCE, candidate.model, share);
  const notReady = candidate.verdict !== "ready";

  return (
    <div className="promote">
      {notReady && (
        <p className="promote__warn" role="alert">
          This candidate is not ready: {candidate.reason}. The dashboard lets you promote it anyway, and warns you first.
        </p>
      )}

      <label className="promote__share">
        <span>Share of {SOURCE} traffic</span>
        <output className="num">{share}%</output>
        <input
          type="range"
          min={1}
          max={50}
          value={share}
          onChange={(e) => setShare(Number(e.target.value))}
          style={{ "--fill": `${((share - 1) / 49) * 100}%` } as CSSProperties}
        />
      </label>

      <div className="promote__split num" aria-hidden="true">
        <span style={{ flexGrow: 100 - share }}>
          {SOURCE.split("/")[1]} {100 - share}%
        </span>
        <span style={{ flexGrow: share }} data-canary>
          {share}%
        </span>
      </div>

      <div className="promote__rule">
        <p>Routing rule</p>
        <pre data-lenis-prevent>
          <code>{JSON.stringify(rule, null, 2)}</code>
        </pre>
      </div>

      <div className="promote__actions">
        <p>
          On this page the rule is only shown. In the dashboard the same button posts it to <code>/api/routing/rules</code>.
        </p>
        <button type="button" className="btn" onClick={() => onCreate(share)}>
          {current === null ? "Create canary rule" : "Change the share"}
        </button>
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  canary,
  onInspect,
  onPromote,
}: {
  candidate: Candidate;
  canary: number | null;
  onInspect: () => void;
  onPromote: () => void;
}) {
  const failed = candidate.samples - candidate.passes;
  return (
    <article className="cand" data-verdict={candidate.verdict}>
      <header className="cand__head">
        <div>
          <p className="cand__pair">
            <span className="model">{SOURCE}</span>
            <span className="cand__to" aria-label="to">
              <svg width="22" height="10" viewBox="0 0 22 10" fill="none" aria-hidden="true">
                <path d="M0 5h20M16 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="model cand__model">{candidate.model}</span>
            <span className="verdict" data-verdict={candidate.verdict}>
              {VERDICT_LABEL[candidate.verdict]}
            </span>
          </p>
          <p className="cand__reason num">{candidate.reason}</p>
        </div>
        <div className="cand__actions">
          <button type="button" className="btn btn--ghost btn--small" onClick={onInspect}>
            View disagreements
          </button>
          <button type="button" className={`btn btn--small ${candidate.verdict === "ready" ? "btn--sun" : "btn--ghost"}`} onClick={onPromote}>
            {canary === null ? "Promote to canary" : "Change canary share"}
          </button>
        </div>
      </header>

      <div className="cand__bar" aria-hidden="true">
        <span className="cand__bar-need" style={{ left: axis(0.9) }}>
          <i>needs 90%</i>
        </span>
        <span
          className="cand__bar-interval"
          style={{ left: axis(candidate.lowerBound), right: `calc(100% - ${axis(candidate.agreement)})` }}
        />
        <span className="cand__bar-point" style={{ left: axis(candidate.agreement) }} />
      </div>

      <dl className="cand__figures num">
        <div>
          <dt>Agreement</dt>
          <dd>{pct(candidate.agreement)}</dd>
          <dd className="cand__sub">95% lower bound {pct(candidate.lowerBound)}</dd>
        </div>
        <div>
          <dt>Compared</dt>
          <dd>{candidate.samples}</dd>
          <dd className="cand__sub">
            {failed} {failed === 1 ? "disagreement" : "disagreements"}
          </dd>
        </div>
        <div>
          <dt>Error rate</dt>
          <dd>{pct(candidate.errorRate)}</dd>
          <dd className="cand__sub">
            {candidate.errors} of {candidate.samples} failed
          </dd>
        </div>
        <div>
          <dt>Judge score</dt>
          <dd>
            {candidate.judgePrimary.toFixed(1)} <small>vs</small> {candidate.judgeCandidate.toFixed(1)}
          </dd>
          <dd className="cand__sub">Primary vs candidate, out of 10</dd>
        </div>
        <div>
          <dt>Latency, p50</dt>
          <dd>
            {candidate.p50Primary} <small>to</small> {candidate.p50Candidate} <small>ms</small>
          </dd>
          <dd className="cand__sub">Primary to candidate</dd>
        </div>
        <div>
          <dt>Savings</dt>
          <dd data-tone="good">{candidate.savingsPct}%</dd>
          <dd className="cand__sub">${candidate.savingsPerMillion} per million requests</dd>
        </div>
      </dl>

      {canary !== null && (
        <p className="cand__canary num" role="status">
          <b>Canary rule created.</b> {canary}% of {SOURCE} traffic goes to {candidate.model}; {100 - canary}% stays on the primary.
        </p>
      )}
    </article>
  );
}

export function Scorecard() {
  const [inspecting, setInspecting] = useState<Candidate | null>(null);
  const [promoting, setPromoting] = useState<Candidate | null>(null);
  const [canaries, setCanaries] = useState<Record<string, number>>({});

  return (
    <section className="section scorecard" id="scorecard">
      <div className="wrap">
        <div className="head">
          <h2 className="h2">Both candidates are far cheaper. Only one is safe.</h2>
          <p className="lede">
            The key-free demo sends 300 mixed requests through a real Bifrost gateway: short answers, arithmetic, JSON mode, tool calls
            and writing, a quarter of them streamed. Two cheaper models shadow gpt-4o. This is the scorecard it prints.
          </p>
        </div>

        <div className="board">
          <header className="board__head">
            <p>
              Models <span aria-hidden="true">/</span> <b>Shadow Traffic</b>
            </p>
            <p className="board__exp">
              Experiment <b>{EXPERIMENT}</b>
            </p>
          </header>
          {CANDIDATES.map((c) => (
            <CandidateCard
              key={c.id}
              candidate={c}
              canary={canaries[c.id] ?? null}
              onInspect={() => setInspecting(c)}
              onPromote={() => setPromoting(c)}
            />
          ))}
        </div>

        <p className="scorecard__note small muted">
          Numbers from one demo run against a deterministic mock upstream. Sampling is random, so they move between runs: in six
          consecutive runs gpt-4o-mini was ready every time, with a lower bound between 95.9% and 97.7%, and llama-3.1-8b never was.
        </p>
      </div>

      <Dialog
        open={inspecting !== null}
        onClose={() => setInspecting(null)}
        variant="sheet"
        title="Disagreements"
        subtitle={
          inspecting && (
            <>
              <span className="model">{SOURCE}</span> against <span className="model">{inspecting.model}</span>. A sample of the{" "}
              {inspecting.samples - inspecting.passes} failing pairs.
            </>
          )
        }
      >
        {inspecting && DISAGREEMENTS[inspecting.id].map((r) => <Record key={r.id} record={r} candidate={inspecting} />)}
      </Dialog>

      <Dialog
        open={promoting !== null}
        onClose={() => setPromoting(null)}
        variant="modal"
        title="Promote to canary"
        subtitle={promoting && <span className="model">{promoting.model}</span>}
      >
        {promoting && (
          <PromoteForm
            key={promoting.id}
            candidate={promoting}
            current={canaries[promoting.id] ?? null}
            onCreate={(share) => {
              setCanaries((prev) => ({ ...prev, [promoting.id]: share }));
              setPromoting(null);
            }}
          />
        )}
      </Dialog>
    </section>
  );
}
