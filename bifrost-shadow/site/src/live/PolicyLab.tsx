import { useId, useMemo, useState, type ReactNode } from "react";
import { VERDICT_LABEL, type Verdict } from "../lib/stats";
import { count, modelId, pct } from "./backend";
import {
  LIMITS,
  MAP_BARS,
  MAP_TOLERANCES,
  OUTCOME_LABEL,
  barLabel,
  comparisonsAtRate,
  highestReadyBar,
  labAll,
  policyFrom,
  samePolicy,
  thresholdsSnippet,
  type CandidateLab,
  type Flip,
  type Policy,
} from "./policy";
import { comparisonsToClear, type RecordsState } from "./records";
import type { PairSummary, Summary, Thresholds } from "./shadowClient";
import "./policy.css";

const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;
const points = (v: number) => `${Number(v.toFixed(2))} ${v === 1 ? "point" : "points"}`;
/** Rounds away float noise from slider arithmetic. */
const tidy = (v: number) => Math.round(v * 10000) / 10000;

/**
 * The policy being tried, kept outside the component so it survives a visit to
 * another tab (such as opening a comparison that changed outcome) and back.
 */
let kept: Partial<Policy> = {};

/**
 * Policy lab: what the verdicts would be if the gate were set differently. It
 * decides the loaded comparisons again under the thresholds set here and shows,
 * per candidate, what changes, which comparisons change outcome, what a stricter
 * bar costs in comparisons, and the thresholds block to put on the gateway.
 */
export function PolicyLab({ data, summary }: { data: RecordsState; summary?: Summary }) {
  const t = summary?.thresholds;
  const gateway = useMemo(
    () => (t ? policyFrom(t) : undefined),
    // The summary is polled every few seconds; only a change of value should count.
    [t?.min_agreement, t?.min_samples, t?.max_error_rate, t?.quality_tolerance],
  );
  const [edits, setEditsState] = useState<Partial<Policy>>(() => kept);
  const setEdits = (next: Partial<Policy> | ((e: Partial<Policy>) => Partial<Policy>)) =>
    setEditsState((e) => (kept = typeof next === "function" ? next(e) : next));
  const policy = useMemo(() => (gateway ? { ...gateway, ...edits } : undefined), [gateway, edits]);
  const labs = useMemo(
    () => (gateway && policy && t ? labAll(data.records, summary?.pairs, gateway, policy, t.max_judge_error_rate) : []),
    [data.records, summary?.pairs, gateway, policy, t],
  );

  const heading = (
    <div className="lv-head">
      <h1 className="lv-h2" id="policy-h">
        Policy lab
      </h1>
      <p className="muted small">
        What if the gate were set differently? Move the controls and every loaded comparison is decided again under your policy, the way the
        gateway would decide it. Nothing on the gateway changes until you copy the thresholds into its config.
      </p>
    </div>
  );

  if (!summary || !gateway || !policy || !t || !data.loaded || data.records.length === 0) {
    return (
      <section className="wrap lv-section lv-policy" aria-labelledby="policy-h">
        {heading}
        <p className="lv-empty">
          {!summary
            ? "Loading the gateway's thresholds…"
            : !data.loaded
              ? "Loading the comparisons…"
              : "No comparisons yet. The lab works on the gateway's own comparisons, so it fills in once sampled traffic has been scored."}
        </p>
      </section>
    );
  }

  const set = (patch: Partial<Policy>) => setEdits((e) => ({ ...e, ...patch }));
  const same = samePolicy(gateway, policy);
  const unscored = labs.reduce((n, l) => n + l.records.filter((r) => !r.candidate_error && r.pass_basis === "unscored").length, 0);
  const changed = labs.filter((l) => l.now.verdict !== l.sim.verdict).length;
  const flips = labs.reduce((n, l) => n + l.flips.length, 0);
  const partial = data.total > data.records.length;

  return (
    <section className="wrap lv-section lv-policy" aria-labelledby="policy-h">
      {heading}

      <p className="lv-policy__scope small">
        <b>Works on the newest {plural(data.records.length, "comparison")} loaded in this browser</b>
        {partial ? `, not all ${count(data.total)} the gateway holds` : ""}. The gateway&rsquo;s column below counts the same loaded
        comparisons, so it can differ from the scorecards, which count everything the gateway keeps.
      </p>

      <div className="lv-policy__layout">
        <Controls gateway={gateway} policy={policy} set={set} reset={() => setEdits({})} same={same} unscored={unscored} />

        <div className="lv-policy__results">
          <h2 className="sr-only">What changes</h2>
          <p className="lv-policy__headline" role="status" aria-live="polite">
            {same ? (
              <>This is the gateway&rsquo;s own policy. Move a control to see what would change.</>
            ) : (
              <>
                With your policy, <b>{changed === 0 ? "no verdict changes" : `${plural(changed, "verdict")} ${changed === 1 ? "changes" : "change"}`}</b>{" "}
                and <b>{flips === 0 ? "no comparison changes outcome" : `${plural(flips, "comparison")} ${flips === 1 ? "changes" : "change"} outcome`}</b>.
              </>
            )}
          </p>

          {labs.map((l) => (
            <CandidateCard
              key={l.key}
              lab={l}
              policy={policy}
              gateway={gateway}
              pair={summary.pairs.find((p) => p.experiment === l.experiment && modelId(p.candidate) === modelId(l.candidate))}
              partial={partial}
              multi={summary.experiments.length > 1}
              onPick={(minAgreement, qualityTolerance) => set({ minAgreement, qualityTolerance })}
            />
          ))}

          <Flips labs={labs} policy={policy} />

          <Snippet policy={policy} thresholds={t} />
        </div>
      </div>
    </section>
  );
}

// ---------- controls ----------

function Controls({
  gateway,
  policy,
  set,
  reset,
  same,
  unscored,
}: {
  gateway: Policy;
  policy: Policy;
  set: (patch: Partial<Policy>) => void;
  reset: () => void;
  same: boolean;
  unscored: number;
}) {
  const hintId = useId();
  return (
    <form className="lv-policy__controls" aria-labelledby="policy-controls-h" onSubmit={(e) => e.preventDefault()}>
      <div className="lv-policy__controls-head">
        <h2 className="lv-policy__h3" id="policy-controls-h">
          Your policy
        </h2>
        <button type="button" className="btn btn--ghost btn--small" onClick={reset} disabled={same} aria-label="Reset to the gateway's policy">
          Reset
        </button>
      </div>

      <Slider
        label="Min agreement"
        value={policy.minAgreement}
        gateway={gateway.minAgreement}
        limits={LIMITS.minAgreement}
        scale={100}
        format={barLabel}
        onChange={(v) => set({ minAgreement: v })}
        hint="Ready needs the 95% lower bound of agreement at or above this. A higher bar lets fewer bad answers through and takes more comparisons to clear."
      />
      <Slider
        label="Min samples"
        value={policy.minSamples}
        gateway={gateway.minSamples}
        limits={LIMITS.minSamples}
        scale={1}
        format={(v) => count(v)}
        onChange={(v) => set({ minSamples: Math.round(v) })}
        hint="Counted comparisons before any verdict. Until then a candidate is collecting, however well it does."
      />
      <Slider
        label="Max error rate"
        value={policy.maxErrorRate}
        gateway={gateway.maxErrorRate}
        limits={LIMITS.maxErrorRate}
        scale={100}
        format={(v) => barLabel(v)}
        onChange={(v) => set({ maxErrorRate: v })}
        hint="Share of candidate calls that may fail outright. Above it a candidate is not ready, whatever its agreement."
      />
      <Slider
        label="Judge quality tolerance"
        value={policy.qualityTolerance}
        gateway={gateway.qualityTolerance}
        limits={LIMITS.qualityTolerance}
        scale={1}
        format={points}
        onChange={(v) => set({ qualityTolerance: v })}
        hint="Judge points, out of 10, the candidate may trail the primary by and still pass. At 0 it must score at least as high."
      />

      <div className="lv-policy__toggle">
        <input
          id={`${hintId}-unscored`}
          type="checkbox"
          checked={policy.unscoredFail}
          onChange={(e) => set({ unscoredFail: e.target.checked })}
          aria-describedby={`${hintId}-unscored-hint`}
        />
        <div>
          <label htmlFor={`${hintId}-unscored`}>Count unscored pairs as failures</label>
          <p className="small muted" id={`${hintId}-unscored-hint`}>
            A pair is unscored when no signal could judge it, such as a failed judge call; the gateway leaves it out of both agreement and
            the sample count. {unscored === 0 ? "None of the loaded pairs is unscored." : `${plural(unscored, "loaded pair")} ${unscored === 1 ? "is" : "are"} unscored.`}
          </p>
        </div>
      </div>

      <details className="lv-policy__rules">
        <summary>How each comparison is decided again</summary>
        <ul className="small muted">
          <li>A candidate error stays an error, and counts as a disagreement.</li>
          <li>A different tool, broken JSON structure, or different tool arguments with no judge stays a failure.</li>
          <li>A judge verdict is decided again from its two scores with your tolerance.</li>
          <li>An exact match, an embedding or a token-overlap decision keeps its outcome: the lab cannot rescore those.</li>
          <li>An unscored pair stays out unless you count it as a failure.</li>
          <li>The judge error limit stays at the gateway&rsquo;s value.</li>
        </ul>
      </details>
    </form>
  );
}

function Slider({
  label,
  value,
  gateway,
  limits,
  scale,
  format,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  gateway: number;
  limits: { min: number; max: number; step: number };
  /** Slider units per value unit: 100 shows fractions as percentages. */
  scale: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  hint: string;
}) {
  const id = useId();
  // A gateway value outside the usual range widens it, so the slider can show where the gateway stands.
  const min = Math.min(limits.min, gateway);
  const max = Math.max(limits.max, gateway);
  const at = (v: number) => String((v - min) / (max - min));
  const moved = value !== gateway;
  return (
    <div className="lv-policy__slider" data-moved={moved || undefined}>
      <div className="lv-policy__slider-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="num">
          {format(value)}
        </output>
      </div>
      <div className="lv-policy__track" style={{ ["--gw" as string]: at(gateway) }}>
        <input
          id={id}
          type="range"
          min={tidy(min * scale)}
          max={tidy(max * scale)}
          step={tidy(limits.step * scale)}
          value={tidy(value * scale)}
          onChange={(e) => onChange(tidy(Number(e.target.value) / scale))}
          aria-valuetext={format(value)}
          aria-describedby={`${id}-hint`}
        />
        <span className="lv-policy__gw" aria-hidden="true" />
      </div>
      <p className="small muted" id={`${id}-hint`}>
        {hint} <span className="lv-policy__gw-text">Gateway: {format(gateway)}.</span>
      </p>
    </div>
  );
}

// ---------- per candidate ----------

function CandidateCard({
  lab: l,
  policy,
  gateway,
  pair,
  partial,
  multi,
  onPick,
}: {
  lab: CandidateLab;
  policy: Policy;
  gateway: Policy;
  pair?: PairSummary;
  partial: boolean;
  multi: boolean;
  onPick: (minAgreement: number, tolerance: number) => void;
}) {
  const flipped = l.now.verdict !== l.sim.verdict;
  const rows: { label: string; hint: string; now: ReactNode; sim: ReactNode; changed: boolean }[] = [
    {
      label: "Agreement",
      hint: "passes out of counted comparisons",
      now: (
        <>
          {pct(l.now.agreement)}
          <small>
            {count(l.now.passes)} of {count(l.now.counted)}
          </small>
        </>
      ),
      sim: (
        <>
          {pct(l.sim.agreement)}
          <small>
            {count(l.sim.passes)} of {count(l.sim.counted)}
          </small>
        </>
      ),
      changed: l.now.passes !== l.sim.passes || l.now.counted !== l.sim.counted,
    },
    {
      label: "95% lower bound",
      hint: "what has to reach the bar",
      now: (
        <>
          {pct(l.now.lowerBound)}
          <small>bar {barLabel(gateway.minAgreement)}</small>
        </>
      ),
      sim: (
        <>
          {pct(l.sim.lowerBound)}
          <small>bar {barLabel(policy.minAgreement)}</small>
        </>
      ),
      changed: l.now.lowerBound !== l.sim.lowerBound || gateway.minAgreement !== policy.minAgreement,
    },
    {
      label: "Error rate",
      hint: "candidate calls that failed",
      now: (
        <>
          {pct(l.now.errorRate)}
          <small>limit {barLabel(gateway.maxErrorRate)}</small>
        </>
      ),
      sim: (
        <>
          {pct(l.sim.errorRate)}
          <small>limit {barLabel(policy.maxErrorRate)}</small>
        </>
      ),
      changed: gateway.maxErrorRate !== policy.maxErrorRate,
    },
  ];

  return (
    <article className="lv-policy__cand" data-flipped={flipped || undefined} aria-label={modelId(l.candidate)}>
      <header className="lv-policy__cand-head">
        <h3 className="lv-policy__h3">
          <span className="model">{modelId(l.candidate)}</span>
          {multi && <span className="small muted"> in {l.experiment}</span>}
        </h3>
        {flipped && <span className="lv-policy__flipchip">Verdict changes</span>}
      </header>

      <table className="lv-policy__table num">
        <caption className="sr-only">{modelId(l.candidate)} under the gateway&rsquo;s policy and under yours</caption>
        <thead>
          <tr>
            <td />
            <th scope="col">Gateway&rsquo;s policy</th>
            <th scope="col">Yours</th>
          </tr>
        </thead>
        <tbody>
          <tr className="lv-policy__verdict-row">
            <th scope="row">Verdict</th>
            <td>
              <span className="verdict" data-verdict={l.now.verdict}>
                {VERDICT_LABEL[l.now.verdict]}
              </span>
            </td>
            <td data-changed={flipped || undefined}>
              <span className="verdict" data-verdict={l.sim.verdict}>
                {VERDICT_LABEL[l.sim.verdict]}
              </span>
            </td>
          </tr>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">
                {r.label}
                <small>{r.hint}</small>
              </th>
              <td>{r.now}</td>
              <td data-changed={r.changed || undefined}>{r.sim}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="lv-policy__why small">
        <span className="muted">Yours: </span>
        {l.sim.reason}
        {l.flips.length > 0 && (
          <>
            {" "}
            {/* A hash link would leave the tab: the console keeps the open tab in the hash. */}
            <button
              type="button"
              className="link lv-policy__jump"
              onClick={() => document.getElementById("policy-flips")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              {plural(l.flips.length, "comparison")} {l.flips.length === 1 ? "changes" : "change"} outcome
            </button>
            .
          </>
        )}
      </p>
      {pair && pair.verdict !== l.now.verdict && (
        <p className="lv-policy__note small muted">
          The scorecard says {VERDICT_LABEL[pair.verdict]}: it counts all {plural(pair.samples, "comparison")} the gateway holds for this
          candidate{partial ? ", more than are loaded here" : ""}.
        </p>
      )}
      {l.stale > 0 && (
        <p className="lv-policy__note small muted">
          {plural(l.stale, "loaded comparison")} {l.stale === 1 ? "was" : "were"} judged under an earlier tolerance; the gateway&rsquo;s
          column keeps the outcome {l.stale === 1 ? "it was" : "they were"} given.
        </p>
      )}

      <VerdictMap lab={l} policy={policy} gateway={gateway} onPick={onPick} />
      <Cost lab={l} policy={policy} />
    </article>
  );
}

// ---------- verdict map ----------

const TOL_ROWS = [...MAP_TOLERANCES].reverse();
const BAR_TICKS = [0.8, 0.85, 0.9, 0.95, 0.995];
const col = (bar: number) => MAP_BARS.findIndex((b) => Math.abs(b - bar) < 1e-9);
const row = (tol: number) => TOL_ROWS.findIndex((t) => Math.abs(t - tol) < 1e-9);

/**
 * Verdict per bar (columns) and tolerance (rows), with the other settings as
 * simulated: where the candidate stands across every policy nearby, with the
 * gateway's and yours marked.
 */
function VerdictMap({
  lab: l,
  policy,
  gateway,
  onPick,
}: {
  lab: CandidateLab;
  policy: Policy;
  gateway: Policy;
  onPick: (minAgreement: number, tolerance: number) => void;
}) {
  const capId = useId();
  const g = { c: col(gateway.minAgreement), r: row(gateway.qualityTolerance) };
  const y = { c: col(policy.minAgreement), r: row(policy.qualityTolerance) };
  const simRow = l.map[MAP_TOLERANCES.findIndex((t) => Math.abs(t - policy.qualityTolerance) < 1e-9)];
  const best = simRow ? highestReadyBar(simRow) : undefined;
  const flat = l.map.every((r) => r.every((v, i) => v === l.map[0][i]));

  let readout: string;
  if (!simRow) readout = `Your tolerance, ${points(policy.qualityTolerance)}, is off the map.`;
  else if (best === undefined) readout = `At your tolerance of ${points(policy.qualityTolerance)} it is ready at no bar from 80% up.`;
  else if (best >= MAP_BARS[MAP_BARS.length - 1]) readout = `At your tolerance of ${points(policy.qualityTolerance)} it is ready at every bar up to 99.5%.`;
  else readout = `At your tolerance of ${points(policy.qualityTolerance)} it is ready for any bar up to ${barLabel(best)}.`;

  return (
    <figure className="lv-policy__map" aria-labelledby={capId}>
      <figcaption id={capId}>
        <span className="lv-policy__map-title">Verdict map</span>
        <span className="small muted">
          {" "}
          Each cell is the verdict at one bar (across) and one tolerance (up), with your other settings. {readout}
          {l.judgeDecided === 0
            ? " No comparison for this candidate was decided by the judge, so the tolerance changes nothing."
            : flat
              ? " The judge's scores sit far enough apart that tolerances from 0 to 3 give the same outcomes."
              : ""}
        </span>
      </figcaption>
      <div className="lv-policy__map-body">
        <div className="lv-policy__map-yt" aria-hidden="true">
          Tolerance, judge points
        </div>
        <div className="lv-policy__map-y" aria-hidden="true">
          {TOL_ROWS.map((t) => (
            <span key={t}>{Number.isInteger(t) ? t : ""}</span>
          ))}
        </div>
        <div className="lv-policy__map-grid" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${MAP_BARS.length}, minmax(0, 1fr))` }}>
          {TOL_ROWS.map((tol, ri) =>
            MAP_BARS.map((bar, ci) => {
              const v: Verdict = l.map[MAP_TOLERANCES.indexOf(tol)][ci];
              return (
                <div
                  key={`${ri}-${ci}`}
                  className="lv-policy__cell"
                  data-verdict={v}
                  data-gateway={(g.r === ri && g.c === ci) || undefined}
                  data-yours={(y.r === ri && y.c === ci) || undefined}
                  title={`Bar ${barLabel(bar)}, tolerance ${points(tol)}: ${VERDICT_LABEL[v]}`}
                  onClick={() => onPick(bar, tol)}
                />
              );
            }),
          )}
        </div>
        <div className="lv-policy__map-x" aria-hidden="true">
          {BAR_TICKS.map((b) => (
            <span key={b} style={{ left: `${((col(b) + 0.5) / MAP_BARS.length) * 100}%` }}>
              {barLabel(b)}
            </span>
          ))}
        </div>
        <div className="lv-policy__map-xt" aria-hidden="true">
          Min agreement: the bar for the lower bound
        </div>
      </div>
      <ul className="lv-policy__legend small muted">
        <li>
          <i data-verdict="ready" /> Ready
        </li>
        <li>
          <i data-verdict="promising" /> Promising
        </li>
        <li>
          <i data-verdict="not_ready" /> Not ready
        </li>
        <li>
          <i data-verdict="collecting" /> Collecting
        </li>
        <li>
          <i data-mark="gateway" /> Gateway&rsquo;s policy
        </li>
        <li>
          <i data-mark="yours" /> Yours
        </li>
      </ul>
      <p className="lv-policy__map-hint small muted">Click a cell to try that bar and tolerance; the sliders do the same from the keyboard.</p>
    </figure>
  );
}

// ---------- cost of strictness ----------

const COST_TOP = 10000;
const logH = (n: number) => Math.max(0, Math.min(1, Math.log10(Math.max(n, 1)) / Math.log10(COST_TOP)));

/**
 * What a stricter bar costs: counted comparisons needed for the lower bound to
 * reach each bar if agreement stays where it is, against how many there are.
 */
function Cost({ lab: l, policy }: { lab: CandidateLab; policy: Policy }) {
  const s = l.sim;
  const rate = s.agreement;
  const have = s.counted;
  const need = (bar: number) => {
    const n = comparisonsAtRate(rate, bar);
    return n === undefined ? undefined : Math.max(n, policy.minSamples);
  };
  const atBar = need(policy.minAgreement);
  const best = comparisonsToClear(s.passes, s.counted, policy.minAgreement);
  const bar = barLabel(policy.minAgreement);

  let text: ReactNode;
  if (s.counted === 0) text = "No counted comparisons yet.";
  else if (atBar !== undefined && atBar <= have)
    text = (
      <>
        At the observed {pct(rate)}, a bar of {bar} needs about <b>{count(atBar)}</b> counted comparisons; there are {count(have)}, so it is met.
        {s.verdict === "not_ready" ? " The verdict is held back by the error rate or the judge, not by evidence." : ""}
      </>
    );
  else if (atBar !== undefined)
    text = (
      <>
        At the observed {pct(rate)}, the lower bound reaches {bar} after about <b>{count(atBar)}</b> counted comparisons,{" "}
        <b>{count(atBar - have)} more</b> than the {count(have)} now. If every new one agreed, {best === undefined ? "over 5,000" : count(best)} more
        would do.
      </>
    );
  else
    text = (
      <>
        The observed agreement, {pct(rate)}, is not above your bar of {bar}, so more comparisons at this rate never clear it.{" "}
        {best === undefined ? "Even perfect answers from here would take over 5,000 more." : `Even if every new one agreed, it would take ${count(best)} more.`}
      </>
    );

  return (
    <div className="lv-policy__cost">
      <p className="lv-policy__map-title">Cost of strictness</p>
      <div className="lv-policy__cost-body">
        <div className="lv-policy__cost-y" aria-hidden="true">
          <span>10k</span>
          <span>100</span>
          <span>1</span>
        </div>
        <div className="lv-policy__cost-plot" aria-hidden="true">
          <div className="lv-policy__cost-grid" style={{ gridTemplateColumns: `repeat(${MAP_BARS.length}, minmax(0, 1fr))` }}>
            {MAP_BARS.map((b, i) => {
              const n = need(b);
              const state = n === undefined || n > COST_TOP ? "never" : n <= have ? "met" : "short";
              return (
                <span
                  key={b}
                  data-state={state}
                  data-yours={i === col(policy.minAgreement) || undefined}
                  style={{ height: state === "never" ? "100%" : `${logH(n!) * 100}%` }}
                  title={n === undefined ? `Bar ${barLabel(b)}: never at ${pct(rate)}` : `Bar ${barLabel(b)}: about ${count(n)} counted comparisons`}
                />
              );
            })}
          </div>
          {have > 0 && (
            <div className="lv-policy__cost-have" style={{ bottom: `${logH(have) * 100}%` }}>
              <span>{count(have)} now</span>
            </div>
          )}
        </div>
      </div>
      <ul className="lv-policy__legend small muted">
        <li>
          <i data-cost="met" /> Enough already
        </li>
        <li>
          <i data-cost="short" /> Needs more
        </li>
        <li>
          <i data-cost="never" /> Never at this rate
        </li>
      </ul>
      <p className="small">{text}</p>
    </div>
  );
}

// ---------- flips ----------

const FLIP_PAGE = 25;

function Flips({ labs, policy }: { labs: CandidateLab[]; policy: Policy }) {
  const [all, setAll] = useState(false);
  const list = labs
    .flatMap((l) => l.flips.map((f) => ({ f, l })))
    .sort((a, b) => Date.parse(b.f.record.created_at) - Date.parse(a.f.record.created_at));
  const shown = all ? list : list.slice(0, FLIP_PAGE);

  // When nothing flips, say how far the nearest judge verdict is from flipping.
  const nearest = () => {
    const tol = policy.qualityTolerance;
    const outside = labs.flatMap((l) => l.deficits).filter((d) => d > tol);
    if (outside.length === 0) return undefined;
    return Math.min(...outside);
  };

  return (
    <section className="lv-policy__flips" id="policy-flips" aria-labelledby="policy-flips-h">
      <h2 className="lv-policy__h3" id="policy-flips-h">
        Comparisons that change outcome
      </h2>
      {list.length === 0 ? (
        <p className="small muted">
          None. Every loaded comparison keeps the outcome the gateway gave it.
          {(() => {
            const n = nearest();
            return n === undefined
              ? ""
              : ` The closest failing judge verdict has the candidate ${points(n)} behind the primary, so only a tolerance of ${points(n)} or more would pass it.`;
          })()}
        </p>
      ) : (
        <>
          <p className="small muted">
            Newest first. Each one is a comparison the gateway decided one way and your policy decides the other; open it to read both answers
            and the judge&rsquo;s reason.
          </p>
          <ul className="lv-policy__flip-list">
            {shown.map(({ f, l }) => (
              <FlipRow key={f.record.id} flip={f} model={l.candidate.model} />
            ))}
          </ul>
          {list.length > FLIP_PAGE && (
            <button type="button" className="btn btn--ghost btn--small lv-policy__more" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer" : `Show all ${count(list.length)}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function FlipRow({ flip: f, model }: { flip: Flip; model: string }) {
  const r = f.record;
  const prompt = (r.prompt ?? "").replace(/\s+/g, " ").trim();
  const signal = r.judge
    ? `Judge ${r.judge.primary_score} for the primary, ${r.judge.candidate_score} for the candidate`
    : r.pass_basis === "unscored"
      ? r.judge_error
        ? "Judge call failed"
        : "No signal could score it"
      : "";
  return (
    <li>
      <a className="lv-policy__flip" href={`#comparisons/${r.id}`}>
        <span className="lv-policy__flip-who">
          <span className="model">{model}</span>
          <time className="small muted num" dateTime={r.created_at}>
            {new Date(r.created_at).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
          </time>
        </span>
        <span className="lv-policy__flip-prompt small">{prompt || <span className="muted">Prompt not stored</span>}</span>
        <span className="lv-policy__flip-signal small muted num">{signal}</span>
        <span className="lv-policy__flip-out small">
          <span className="muted">Gateway</span> <b data-outcome={f.from}>{OUTCOME_LABEL[f.from]}</b>
          <span className="muted">, yours</span> <b data-outcome={f.to}>{OUTCOME_LABEL[f.to]}</b>
        </span>
      </a>
    </li>
  );
}

// ---------- thresholds for the gateway ----------

function Snippet({ policy, thresholds }: { policy: Policy; thresholds: Thresholds }) {
  const [copied, setCopied] = useState<"yes" | "no">();
  const json = thresholdsSnippet(policy, thresholds);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
    setTimeout(() => setCopied(undefined), 2500);
  };
  return (
    <section className="lv-policy__out" aria-labelledby="policy-out-h">
      <h2 className="lv-policy__h3" id="policy-out-h">
        Put this policy on the gateway
      </h2>
      <p className="small muted">
        The shadow plugin reads these from <code>thresholds</code> in its config: in <code>config.json</code>, inside the plugin entry named{" "}
        <code>"shadow"</code> at <code>config.thresholds</code>; over the API, in the config you send with <code>PUT /api/plugins/shadow</code>.
        Fields the lab does not change keep the gateway&rsquo;s current values.
      </p>
      <div className="lv-policy__code">
        <pre>
          <code>{json}</code>
        </pre>
        <button type="button" className="btn btn--ghost btn--small" onClick={copy}>
          {copied === "yes" ? "Copied" : copied === "no" ? "Copy failed" : "Copy"}
        </button>
        <span className="sr-only" role="status">
          {copied === "yes" ? "Thresholds copied." : copied === "no" ? "Could not copy; select the text instead." : ""}
        </span>
      </div>
      <ul className="lv-policy__out-notes small muted">
        <li>Updating the plugin starts a fresh instance: without <code>persist_path</code> its comparisons in memory start over.</li>
        <li>Comparisons already stored keep the outcome they were given; a new tolerance decides the ones made after the change.</li>
        {policy.unscoredFail && (
          <li>
            The gateway has no setting for counting unscored pairs as failures; it always leaves them out. To have fewer of them, fix what
            leaves them unscored: a failing judge, or no judge or embeddings at all (or set <code>quality_fallback</code> to{" "}
            <code>"lexical"</code>).
          </li>
        )}
      </ul>
    </section>
  );
}
