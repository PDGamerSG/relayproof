import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { LINKS } from "../data/site";
import { Mark } from "../components/Icons";
import { ago, ConnectionContext, count, errorText, modelId, ms, pct, trialConnection, type Connection, type DemoStatus } from "./backend";
import { AskPanel } from "./Ask";
import { CommandPalette } from "./CommandPalette";
import { ConnectPanel } from "./Connect";
import { DisagreementsDialog, PromoteDialog } from "./Dialogs";
import { DriftWatch } from "./DriftWatch";
import { Explorer } from "./Explorer";
import { Feed } from "./Feed";
import { JudgeCheck } from "./JudgeCheck";
import { Performance } from "./Performance";
import { PolicyLab } from "./PolicyLab";
import { useRecords, type RecordsState } from "./records";
import { Report } from "./Report";
import { Segments } from "./Segments";
import { Setup } from "./Setup";
import { CanaryPanel, Downloads, History, IncidentPanel } from "./Rollout";
import { poll, type PairSummary, type RolloutEvent, type Rollouts, type Summary, type Verdict } from "./shadowClient";
import { Trend } from "./Trend";

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

/** Tabs in the order of the job: watch the evidence, decide on it, act on it. */
const TABS = [
  { id: "overview", label: "Overview", group: "Watch" },
  { id: "ask", label: "Ask", group: "Watch", trialOnly: true },
  { id: "comparisons", label: "Comparisons", group: "Watch" },
  { id: "performance", label: "Performance", group: "Watch" },
  { id: "judge", label: "Judge check", group: "Decide" },
  { id: "policy", label: "Policy lab", group: "Decide" },
  { id: "report", label: "Report", group: "Decide" },
  { id: "rollout", label: "Rollout", group: "Act" },
  { id: "setup", label: "Set up", group: "Act" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

/** 16 px line icons for the sidebar; the top bar on narrow screens leaves them out. */
const TAB_ICON: Record<TabId, string> = {
  overview: "M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z",
  ask: "M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z",
  comparisons: "M2.5 2.5h4.5v11H2.5zM9 2.5h4.5v11H9zM9 6h4.5M9 9.5h4.5",
  judge: "M8 2v11.5M4.5 13.5h7M3 4.5h10M3 4.5 1.5 8.5a1.6 1.6 0 0 0 3 0zM13 4.5l-1.5 4a1.6 1.6 0 0 0 3 0z",
  rollout: "M2.5 13.5 6.5 9l2.5 2.5 4.5-6M10 5.5h3.5V9",
  report: "M4 1.5h5.5l3 3v10H4zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5",
  performance: "M8 14a6 6 0 1 1 6-6M8 8l3-3M2.5 14h11",
  policy: "M2.5 4h11M2.5 8h11M2.5 12h11M5.5 2.5v3M10.5 6.5v3M7 10.5v3",
  setup: "M3 2.5h10v11H3zM5.5 5.5l2 2-2 2M8.5 10h2",
};

/** Older links pointed at sections of the single-page console. */
const LEGACY: Record<string, TabId> = { scorecards: "overview", history: "rollout" };

function readTab(): TabId {
  // "#comparisons/<record id>" opens one comparison.
  const h = window.location.hash.slice(1).split("/")[0];
  if (TABS.some((t) => t.id === h)) return h as TabId;
  return LEGACY[h] ?? "overview";
}

/** The open tab lives in the URL hash, so tabs can be linked and the back button works. */
function useTab(): TabId {
  const [tab, setTab] = useState<TabId>(readTab);
  useEffect(() => {
    const onHash = () => {
      setTab(readTab());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return tab;
}

export function LiveApp() {
  const now = useNow();
  const tab = useTab();
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
  // Records feed the trends, the explorer, the judge check, the policy lab, the report and the palette's search.
  const data = useRecords(conn, true);

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

  const tabs = TABS.filter((t) => !("trialOnly" in t) || conn.demo);
  const active: TabId = tabs.some((t) => t.id === tab) ? tab : "overview";
  const badge: Partial<Record<TabId, string>> = {
    comparisons: summary ? count(summary.counters.completed) : undefined,
    rollout: rollouts && rollouts.canaries.length > 0 ? `${rollouts.canaries.length} live` : undefined,
  };

  return (
    <ConnectionContext.Provider value={conn}>
      <a className="skip" href="#console">
        Skip to the console
      </a>
      <div className="lv-shell">
        <header className="lv-bar">
          <div className="lv-bar__row">
            <a className="lv-bar__brand" href="./" aria-label="RelayProof home">
              <Mark />
              <span>RelayProof</span>
            </a>
            <span className="lv-bar__tag">Live console</span>
            <p className="lv-conn" data-state={connection} role="status" aria-live="polite">
              <span className="lv-conn__dot" aria-hidden="true" />
              {connection === "live" && (
                <>
                  {conn.mode === "trial" ? "Hosted demo" : conn.label}, updated {ago(new Date(lastOk!).toISOString(), now)}
                </>
              )}
              {connection === "connecting" && (conn.mode === "trial" ? "Waking the demo gateway" : `Connecting to ${conn.label}`)}
              {connection === "stale" && "Reconnecting"}
              {connection === "offline" && (conn.mode === "trial" ? "Demo backend offline" : `${conn.label} offline`)}
            </p>
          </div>
          <nav className="lv-tabs" aria-label="Console">
            {tabs.map((t, i) => (
              <Fragment key={t.id}>
                {t.group !== tabs[i - 1]?.group && <p className="lv-tabs__group">{t.group}</p>}
                <a href={`#${t.id}`} aria-current={active === t.id ? "page" : undefined}>
                  <svg className="lv-tabs__icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <path d={TAB_ICON[t.id]} />
                  </svg>
                  {t.label}
                  {badge[t.id] && <span className="lv-tabs__badge num">{badge[t.id]}</span>}
                </a>
              </Fragment>
            ))}
          </nav>
          <p className="lv-bar__foot small">
            <a className="link" href="./">
              What RelayProof is
            </a>
            <a className="link" href={LINKS.docs}>
              Documentation
            </a>
            <a className="link" href={LINKS.repo}>
              Source
            </a>
          </p>
        </header>

        <div className="lv-page">
          <main className="lv" id="console" tabIndex={-1}>
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

            {active === "overview" && (
              <>
                <section className="lv-intro wrap">
                  <div>
                    <h1 className="lv-title">Shadow traffic, live.</h1>
                    <p className="lede">
                      {conn.mode === "trial" ? (
                        status?.upstream && status.upstream !== "mock" ? (
                          <>
                            A hosted Bifrost gateway with the RelayProof plugin, calling real Claude models.{" "}
                            <span className="model">{status.primary_model}</span> answers every request.{" "}
                            {status.incident_models.join(" and ")} answer the same requests in its shadow, and a judge scores each pair. Nobody
                            sees a shadow answer.
                          </>
                        ) : (
                          <>
                            A hosted Bifrost gateway with the RelayProof plugin, serving a mock upstream so no provider keys are involved.
                            Requests are replayed against cheaper models and scored.
                          </>
                        )
                      ) : (
                        <>
                          Signed in to <span className="model">{conn.label}</span>. Scorecards, promotion and rollback act on that gateway and
                          its real traffic.
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

                {summary && <Tiles summary={summary} status={status} />}

                <section className="wrap lv-section" aria-labelledby="scorecards-h">
                  <div className="lv-head">
                    <h2 className="lv-h2" id="scorecards-h">
                      Scorecards
                    </h2>
                    {summary && (
                      <p className="muted small">
                        Experiment <b>{summary.experiments[0]?.name ?? "–"}</b>: every candidate against{" "}
                        <span className="model">{summary.experiments[0] ? modelId(summary.experiments[0].source) : "–"}</span>. Ready needs
                        the 95% lower bound at or above {pct(summary.thresholds.min_agreement, 0)} after {summary.thresholds.min_samples}{" "}
                        scored pairs, and errors at most {pct(summary.thresholds.max_error_rate, 0)}.
                      </p>
                    )}
                  </div>
                  {!summary && !failure && <p className="lv-empty">Loading scorecards…</p>}
                  {summary && summary.pairs.length === 0 && (
                    <p className="lv-empty">
                      No comparisons yet. Scorecards appear once chat traffic for an experiment&rsquo;s source model passes through this
                      gateway and is sampled.
                    </p>
                  )}
                  <div className="lv-cards">
                    {summary?.pairs.map((pair) => (
                      <PairCard
                        key={`${pair.experiment}|${modelId(pair.candidate)}`}
                        pair={pair}
                        minAgreement={summary.thresholds.min_agreement}
                        share={canaryShare(pair)}
                        data={data}
                        events={rollouts?.events}
                        onPromote={() => setPromoting(pair)}
                        onInspect={() => setInspecting(pair)}
                      />
                    ))}
                  </div>
                </section>

                <DriftWatch data={data} summary={summary} events={rollouts?.events} />

                <Segments data={data} summary={summary} />
              </>
            )}

            {active === "ask" && conn.demo && (
              <>
                <AskPanel status={status} />
                <Feed data={data} now={now} />
              </>
            )}

            {active === "comparisons" && <Explorer data={data} summary={summary} />}

            {active === "performance" && <Performance data={data} summary={summary} />}

            {active === "judge" && <JudgeCheck data={data} summary={summary} />}

            {active === "policy" && <PolicyLab data={data} summary={summary} />}

            {active === "setup" && <Setup data={data} summary={summary} />}

            {active === "rollout" && (
              <>
                <section className="lv-umbra umbra" aria-labelledby="rollout-h">
                  <div className="wrap lv-section">
                    <div className="lv-head">
                      <h1 className="lv-h2" id="rollout-h">
                        Canary and incidents
                      </h1>
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

                <section className="wrap lv-section" aria-labelledby="history-h">
                  <div className="lv-head">
                    <h2 className="lv-h2" id="history-h">
                      Rollout history
                    </h2>
                    <p className="muted small">Every promotion and rollback since the gateway started, newest first.</p>
                  </div>
                  <History rollouts={rollouts} now={now} />
                  <Downloads />
                </section>
              </>
            )}

            {active === "report" && <Report data={data} summary={summary} rollouts={rollouts} status={status} />}
          </main>

          <footer className="lv-foot wrap small muted">
            {conn.mode === "trial" ? (
              <p>
                Trial backend: Bifrost at upstream commit ed62e4b with the shadow plugin, on Render. Its public front door exposes only the
                shadow API and the demo controls; it resets canaries after{" "}
                {status ? `${Math.round(status.canary_ttl_seconds / 60)} minutes` : "a while"} and incidents after{" "}
                {status ? `${Math.round(status.incident_ttl_seconds / 60)} minutes` : "a few minutes"}.{" "}
                {status?.upstream && status.upstream !== "mock" ? (
                  <>
                    Model calls are real and capped at {status.daily_request_cap || "an unlimited number of"} requests a day
                    {status.live_traffic_only_when_watched ? "; background traffic runs only while someone has this page open" : ""}. Outages are
                    simulated by a proxy in front of the provider, never caused.
                  </>
                ) : (
                  <>Spend is computed from configured prices; the mock charges nothing.</>
                )}
              </p>
            ) : (
              <p>
                Connected straight to <span className="model">{conn.base}</span> from this browser. Sign out to return to the trial.
              </p>
            )}
            <p className="lv-foot__links">
              <a className="link" href="./">
                Overview
              </a>
              <a className="link" href={LINKS.docs}>
                Documentation
              </a>
              <a className="link" href={LINKS.repo}>
                Source
              </a>
            </p>
          </footer>
        </div>
      </div>

      <CommandPalette tabs={tabs.map((t) => ({ id: t.id, label: t.label }))} data={data} summary={summary} />

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
          // With real models every request costs money, so a larger share gets
          // the guard its minimum number of canary requests sooner.
          defaultShare={status?.upstream && status.upstream !== "mock" ? 0.25 : 0.1}
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
    { done: (status?.asked ?? 0) > 0, text: "Ask your own question.", href: "#ask" },
    { done: ready, text: "Wait for a candidate to reach Ready.", href: "#overview" },
    {
      done: promoted,
      text: status?.upstream && status.upstream !== "mock" ? "Promote it to a 25% canary." : "Promote it to a 10% canary.",
      href: "#overview",
    },
    { done: broken, text: "Simulate an incident on that model.", href: "#rollout" },
    { done: rolledBack, text: "Watch the guard roll it back.", href: "#rollout" },
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
  data,
  events,
  onPromote,
  onInspect,
}: {
  pair: PairSummary;
  minAgreement: number;
  share?: number;
  data: RecordsState;
  events?: RolloutEvent[];
  onPromote: () => void;
  onInspect: () => void;
}) {
  // Matches the records filter outcome=fail: no candidate error and not passed (unscored pairs included).
  const fails = Math.max(0, pair.samples - pair.passes - pair.errors);
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

      <Trend data={data} pair={pair} minAgreement={minAgreement} events={events} />

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
