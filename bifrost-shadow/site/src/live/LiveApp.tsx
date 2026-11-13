import { useCallback, useEffect, useRef, useState } from "react";
import { LINKS } from "../data/site";
import { Mark } from "../components/Icons";
import { ago, ConnectionContext, count, errorText, modelId, ms, pct, trialConnection, type Connection, type DemoStatus } from "./backend";
import { ConnectPanel } from "./Connect";
import { DisagreementsDialog, PromoteDialog } from "./Dialogs";
import { CanaryPanel, Downloads, History, IncidentPanel } from "./Rollout";
import { poll, type PairSummary, type Rollouts, type Summary, type Verdict } from "./shadowClient";

const VERDICT_LABEL: Record<Verdict, string> = {
  collecting: "Collecting",
  promising: "Promising",
  ready: "Ready",
  not_ready: "Not ready",
};

export interface Notice {
  id: number;
  tone: "ok" | "error";
  text: string;
}

export type Notify = (tone: Notice["tone"], text: string) => void;

/** Re-renders every second so "12 s ago" labels move. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function LiveApp() {
  const now = useNow();
  const [conn, setConn] = useState<Connection>(trialConnection);
  const [summary, setSummary] = useState<Summary>();
  const [rollouts, setRollouts] = useState<Rollouts>();
  const [status, setStatus] = useState<DemoStatus>();
  const [lastOk, setLastOk] = useState<number>();
  const [failure, setFailure] = useState<string>();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [promoting, setPromoting] = useState<PairSummary>();
  const [inspecting, setInspecting] = useState<PairSummary>();
  const noticeId = useRef(0);

  const notify = useCallback<Notify>((tone, text) => {
    const id = ++noticeId.current;
    setNotices((list) => [...list.slice(-2), { id, tone, text }]);
    setTimeout(() => setNotices((list) => list.filter((n) => n.id !== id)), tone === "error" ? 9000 : 6000);
  }, []);

  const onSummary = useCallback((s: Summary) => {
    setSummary(s);
    setLastOk(Date.now());
    setFailure(undefined);
  }, []);
  const onFailure = useCallback((err: unknown) => setFailure(errorText(err)), []);

  // A new connection starts from nothing: no data from the previous backend.
  const connect = useCallback((next: Connection) => {
    setSummary(undefined);
    setRollouts(undefined);
    setStatus(undefined);
    setLastOk(undefined);
    setFailure(undefined);
    setPromoting(undefined);
    setInspecting(undefined);
    setConn(next);
  }, []);

  useEffect(() => poll(() => conn.client.summary(), 3000, onSummary, onFailure), [conn, onSummary, onFailure]);
  useEffect(() => poll(() => conn.client.rollouts(), 2000, setRollouts), [conn]);
  useEffect(() => (conn.demo ? poll(conn.demo.status, 3000, setStatus) : undefined), [conn]);

  /** Fetch everything now, after an action changed it. */
  const refresh = useCallback(async () => {
    const [s, r, d] = await Promise.allSettled([conn.client.summary(), conn.client.rollouts(), conn.demo?.status()]);
    if (s.status === "fulfilled") onSummary(s.value);
    if (r.status === "fulfilled") setRollouts(r.value);
    if (d.status === "fulfilled" && d.value) setStatus(d.value);
  }, [conn, onSummary]);

  const connection: "connecting" | "live" | "stale" | "offline" =
    lastOk === undefined ? (failure ? "offline" : "connecting") : failure ? (now - lastOk > 15000 ? "offline" : "stale") : "live";

  const canaryShare = (pair: PairSummary) =>
    rollouts?.canaries.find((c) => c.experiment === pair.experiment && modelId(c.candidate) === modelId(pair.candidate))?.weight;

  return (
    <ConnectionContext.Provider value={conn}>
      <a className="skip" href="#scorecards">
        Skip to the scorecards
      </a>
      <header className="lv-bar">
        <a className="lv-bar__brand" href="./">
          <Mark />
          <span>RelayProof</span>
        </a>
        <span className="lv-bar__tag">Live console</span>
        <nav className="lv-bar__links" aria-label="Sections">
          <a href="#scorecards">Scorecards</a>
          <a href="#rollout">Canary</a>
          <a href="#history">History</a>
        </nav>
        <p className="lv-conn" data-state={connection} role="status" aria-live="polite">
          <span className="lv-conn__dot" aria-hidden="true" />
          {connection === "live" && (
            <>
              {conn.mode === "trial" ? "Trial" : conn.label}, updated {ago(new Date(lastOk!).toISOString(), now)}
            </>
          )}
          {connection === "connecting" && (conn.mode === "trial" ? "Waking the demo gateway" : `Connecting to ${conn.label}`)}
          {connection === "stale" && "Reconnecting"}
          {connection === "offline" && (conn.mode === "trial" ? "Demo backend offline" : `${conn.label} offline`)}
        </p>
      </header>

      <main className="lv">
        <section className="lv-intro wrap">
          <div>
            <p className="lv-eyebrow">A real gateway, running now</p>
            <h1 className="lv-title">Shadow traffic, live.</h1>
            <p className="lede">
              {conn.mode === "trial" ? (
                <>
                  The trial runs on a hosted Bifrost gateway with the RelayProof plugin, serving a mock upstream so no provider keys are
                  involved. A request arrives every second; half are replayed against two cheaper models and scored.
                </>
              ) : (
                <>
                  Signed in to <span className="model">{conn.label}</span>. Scorecards, promotion and rollback act on that gateway and its
                  real traffic.
                </>
              )}
            </p>
            <ConnectPanel conn={conn} onConnect={connect} />
          </div>
          {conn.mode === "trial" ? (
            <Walkthrough summary={summary} rollouts={rollouts} status={status} />
          ) : (
            <ol className="lv-walk" aria-label="On your gateway">
              <li>
                <span className="lv-walk__n num">1</span>Read the scorecards as traffic comes in.
              </li>
              <li>
                <span className="lv-walk__n num">2</span>Promote a ready candidate to a canary.
              </li>
              <li>
                <span className="lv-walk__n num">3</span>Watch its live health; roll back if needed.
              </li>
            </ol>
          )}
        </section>

        {connection === "offline" && (
          <div className="wrap">
            <div className="lv-offline" role="alert">
              {conn.mode === "trial" ? (
                <>
                  <b>The demo backend is not answering yet.</b> {failure} The hosted demo sleeps when nobody uses it and takes about a
                  minute to wake up. This page keeps retrying. The <a href="./">overview</a> runs a simulation that needs no backend.
                </>
              ) : (
                <>
                  <b>{conn.label} is not answering.</b> {failure} This page keeps retrying.
                </>
              )}
            </div>
          </div>
        )}

        {summary && <Tiles summary={summary} status={status} />}

        <section className="wrap lv-section" id="scorecards" aria-labelledby="scorecards-h">
          <div className="lv-head">
            <h2 className="lv-h2" id="scorecards-h">
              Scorecards
            </h2>
            {summary && (
              <p className="muted small">
                Experiment <b>{summary.experiments[0]?.name ?? "–"}</b>: every candidate against{" "}
                <span className="model">{summary.experiments[0] ? modelId(summary.experiments[0].source) : "–"}</span>. Ready needs the
                95% lower bound at or above {pct(summary.thresholds.min_agreement, 0)} after {summary.thresholds.min_samples} scored
                pairs, and errors at most {pct(summary.thresholds.max_error_rate, 0)}.
              </p>
            )}
          </div>
          {!summary && !failure && <p className="lv-empty">Loading scorecards…</p>}
          {summary && summary.pairs.length === 0 && (
            <p className="lv-empty">
              No comparisons yet. Scorecards appear once chat traffic for an experiment&rsquo;s source model passes through this gateway
              and is sampled.
            </p>
          )}
          <div className="lv-cards">
            {summary?.pairs.map((pair) => (
              <PairCard
                key={`${pair.experiment}|${modelId(pair.candidate)}`}
                pair={pair}
                minAgreement={summary.thresholds.min_agreement}
                share={canaryShare(pair)}
                onPromote={() => setPromoting(pair)}
                onInspect={() => setInspecting(pair)}
              />
            ))}
          </div>
        </section>

        <section className="lv-umbra umbra" id="rollout" aria-labelledby="rollout-h">
          <div className="wrap lv-section">
            <div className="lv-head">
              <h2 className="lv-h2" id="rollout-h">
                Canary and incidents
              </h2>
              <p className="muted small">
                A promotion writes one weighted routing rule on the gateway. The canary guard then compares the candidate&rsquo;s live
                error rate and latency with the source&rsquo;s and rolls it back on its own when it fails.
              </p>
            </div>
            <div className="lv-split" data-single={!conn.demo}>
              <CanaryPanel rollouts={rollouts} status={status} now={now} notify={notify} refresh={refresh} />
              {conn.demo && <IncidentPanel status={status} rollouts={rollouts} now={now} notify={notify} refresh={refresh} />}
            </div>
          </div>
        </section>

        <section className="wrap lv-section" id="history" aria-labelledby="history-h">
          <div className="lv-head">
            <h2 className="lv-h2" id="history-h">
              Rollout history
            </h2>
            <p className="muted small">Every promotion and rollback since the gateway started, newest first.</p>
          </div>
          <History rollouts={rollouts} now={now} />
          <Downloads />
        </section>
      </main>

      <footer className="lv-foot wrap small muted">
        {conn.mode === "trial" ? (
          <p>
            Trial backend: Bifrost at upstream commit ed62e4b with the shadow plugin, on Render. Its public front door exposes only the
            shadow API and the demo controls; it resets canaries after{" "}
            {status ? `${Math.round(status.canary_ttl_seconds / 60)} minutes` : "a while"} and incidents after{" "}
            {status ? `${Math.round(status.incident_ttl_seconds / 60)} minutes` : "a few minutes"}. Spend is computed from configured
            prices; the mock charges nothing.
          </p>
        ) : (
          <p>
            Connected straight to <span className="model">{conn.base}</span> from this browser. Sign out to return to the trial.
          </p>
        )}
        <p>
          <a className="link" href="./">
            Overview
          </a>{" "}
          ·{" "}
          <a className="link" href={LINKS.docs}>
            Documentation
          </a>{" "}
          ·{" "}
          <a className="link" href={LINKS.repo}>
            Source
          </a>
        </p>
      </footer>

      <div className="lv-toasts" aria-live="polite">
        {notices.map((n) => (
          <p key={n.id} className="lv-toast" data-tone={n.tone}>
            {n.text}
          </p>
        ))}
      </div>

      {promoting && summary && (
        <PromoteDialog
          pair={promoting}
          current={canaryShare(promoting)}
          onClose={() => setPromoting(undefined)}
          onDone={(text) => {
            setPromoting(undefined);
            notify("ok", text);
            void refresh();
          }}
        />
      )}
      {inspecting && <DisagreementsDialog pair={inspecting} onClose={() => setInspecting(undefined)} />}
    </ConnectionContext.Provider>
  );
}

function Walkthrough({ summary, rollouts, status }: { summary?: Summary; rollouts?: Rollouts; status?: DemoStatus }) {
  const ready = summary?.pairs.some((p) => p.verdict === "ready") ?? false;
  const promoted = (rollouts?.canaries.length ?? 0) > 0 || (rollouts?.events.some((e) => e.action === "promote") ?? false);
  const broken = (status?.incidents.length ?? 0) > 0 || (rollouts?.events.some((e) => e.action === "auto_rollback") ?? false);
  const rolledBack = rollouts?.events.some((e) => e.action === "auto_rollback") ?? false;
  const steps = [
    { done: ready, text: "Wait for a candidate to reach Ready.", href: "#scorecards" },
    { done: promoted, text: "Promote it to a 10% canary.", href: "#scorecards" },
    { done: broken, text: "Simulate an incident on that model.", href: "#rollout" },
    { done: rolledBack, text: "Watch the guard roll it back.", href: "#history" },
  ];
  return (
    <ol className="lv-walk" aria-label="Try it">
      {steps.map((s, i) => (
        <li key={s.text} data-done={s.done}>
          <span className="lv-walk__n num" aria-hidden="true">
            {s.done ? "✓" : i + 1}
          </span>
          <a href={s.href}>{s.text}</a>
          {s.done && <span className="sr-only"> Done.</span>}
        </li>
      ))}
    </ol>
  );
}

function Tiles({ summary, status }: { summary: Summary; status?: DemoStatus }) {
  const c = summary.counters;
  const tiles: { label: string; value: string; note?: string }[] = [
    { label: "Requests seen", value: count(c.eligible), note: status ? `${count(status.live_sent + status.burst_sent)} sent by the demo` : undefined },
    { label: "Sampled", value: count(c.sampled), note: `sample rate ${pct(summary.sample_rate, 0)}` },
    { label: "Comparisons", value: count(c.completed), note: `${count(c.in_flight)} in flight, ${count(c.queue_depth)} queued` },
    { label: "Candidate errors", value: count(c.candidate_errors), note: `${count(c.dropped)} dropped by a full queue` },
    {
      label: "Eval spend today",
      value: `$${summary.spend_today_usd.toFixed(4)}`,
      note: summary.budget_exhausted ? "budget reached, sampling paused" : `of $${summary.daily_budget_usd} daily budget`,
    },
    { label: "Live canaries", value: count(summary.active_canaries), note: summary.auto_rollback ? "auto rollback on" : "auto rollback off" },
  ];
  return (
    <section className="wrap" aria-label="Gateway counters">
      <dl className="lv-tiles">
        {tiles.map((t) => (
          <div key={t.label} className="lv-tile">
            <dt>{t.label}</dt>
            <dd className="num">{t.value}</dd>
            {t.note && <dd className="lv-tile__note">{t.note}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}

const BASIS_LABEL: Record<string, string> = {
  judge: "judge",
  exact: "exact match",
  semantic: "embeddings",
  lexical: "lexical",
  tool_selection: "wrong tool",
  json_schema: "JSON shape",
  tool_arguments: "tool arguments",
  unscored: "unscored",
  structural: "structural",
};

function PairCard({
  pair,
  minAgreement,
  share,
  onPromote,
  onInspect,
}: {
  pair: PairSummary;
  minAgreement: number;
  share?: number;
  onPromote: () => void;
  onInspect: () => void;
}) {
  const fails = Math.max(0, pair.scored + pair.errors - pair.passes);
  // The meter shows 50% to 100%, where verdicts are decided.
  const axis = (f: number) => `${(Math.min(1, Math.max(0, (f - 0.5) / 0.5)) * 100).toFixed(2)}%`;
  const bases = Object.entries(pair.pass_basis_counts ?? {}).filter(([, n]) => (n ?? 0) > 0);
  return (
    <article className="lv-card" data-verdict={pair.verdict}>
      <header className="lv-card__head">
        <p className="lv-card__pair">
          <span className="model">{modelId(pair.source)}</span>
          <span aria-hidden="true">→</span>
          <span className="sr-only">compared with</span>
          <span className="model lv-card__cand">{modelId(pair.candidate)}</span>
        </p>
        <span className="verdict" data-verdict={pair.verdict}>
          {VERDICT_LABEL[pair.verdict]}
        </span>
      </header>
      <p className="lv-card__reason small muted">{pair.verdict_reason}</p>

      <div className="lv-agree">
        <p className="lv-agree__big num">{pct(pair.agreement_rate)}</p>
        <p className="small muted">
          agreement, 95% lower bound <b className="num">{pct(pair.agreement_lower_bound)}</b>
        </p>
        <div className="lv-meter" role="img" aria-label={`Lower bound ${pct(pair.agreement_lower_bound)}, needs ${pct(minAgreement, 0)}`}>
          <span className="lv-meter__range" style={{ left: axis(pair.agreement_lower_bound), right: `calc(100% - ${axis(pair.agreement_rate)})` }} />
          <span className="lv-meter__point" style={{ left: axis(pair.agreement_rate) }} />
          <span className="lv-meter__bar" style={{ left: axis(minAgreement) }} />
        </div>
        <p className="lv-meter__legend small muted num">
          <span>50%</span>
          <span className="lv-meter__need" style={{ left: axis(minAgreement) }}>
            needs {pct(minAgreement, 0)}
          </span>
          <span>100%</span>
        </p>
      </div>

      <dl className="lv-metrics num">
        <div>
          <dt>Scored</dt>
          <dd>
            {count(pair.scored)} <small>of {count(pair.samples)}</small>
          </dd>
        </div>
        <div>
          <dt>Error rate</dt>
          <dd>
            {pct(pair.error_rate)} <small>{count(pair.errors)} failed</small>
          </dd>
        </div>
        <div>
          <dt>Judge, out of 10</dt>
          <dd>
            {pair.judged > 0 ? `${pair.avg_primary_score.toFixed(1)} vs ${pair.avg_candidate_score.toFixed(1)}` : "–"}
            {pair.judge_errors > 0 && <small>{pct(pair.judge_error_rate)} judge errors</small>}
          </dd>
        </div>
        <div>
          <dt>Latency p50</dt>
          <dd>
            {ms(pair.primary_latency.p50_ms)} → {ms(pair.candidate_latency.p50_ms)}
          </dd>
        </div>
        <div>
          <dt>Savings</dt>
          <dd>
            {pct(pair.savings_pct / 100)} <small>${pair.savings_per_million_usd.toFixed(0)} per 1M requests</small>
          </dd>
        </div>
        {pair.tool_turns > 0 && (
          <div>
            <dt>Tool calls</dt>
            <dd>
              {pct(pair.tool_call_match_rate)} <small>same calls in {count(pair.tool_turns)} tool turns</small>
            </dd>
          </div>
        )}
      </dl>

      {bases.length > 0 && (
        <p className="lv-bases small muted">
          Decided by{" "}
          {bases.map(([basis, n], i) => (
            <span key={basis}>
              {i > 0 && ", "}
              {BASIS_LABEL[basis] ?? basis} <b className="num">{n}</b>
            </span>
          ))}
        </p>
      )}

      <div className="lv-card__actions">
        {share !== undefined && (
          <span className="lv-live-chip">
            Live canary, {pct(share, 0)} of {pair.source.model}
          </span>
        )}
        <button type="button" className="btn btn--ghost btn--small" onClick={onInspect} disabled={fails === 0}>
          {fails === 0 ? "No disagreements" : `View ${count(fails)} disagreement${fails === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          className={`btn btn--small ${pair.verdict === "ready" ? "btn--sun" : "btn--ghost"}`}
          onClick={onPromote}
        >
          {share !== undefined ? "Change canary share" : pair.verdict === "ready" ? "Promote to canary" : "Promote with override"}
        </button>
      </div>
    </article>
  );
}
