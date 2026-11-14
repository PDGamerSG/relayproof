import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { count, modelId, pct } from "./backend";
import {
  DEFAULT_TOLERANCE,
  MIN_PER_ARM,
  excludesZero,
  judgedRecords,
  judgeFamilyLinks,
  judgeHealth,
  modelFamily,
  positionBias,
  scoreGaps,
  verbosity,
  type FamilyLink,
  type JudgeHealth,
  type PositionArm,
  type PositionBias,
  type ScoreGaps,
  type Verbosity,
} from "./judgeStats";
import { candidateKey, type RecordsState } from "./records";
import type { Summary } from "./shadowClient";
import "./judge.css";

const ZHENG = "https://arxiv.org/abs/2306.05685";
const PANICKSSERY = "https://arxiv.org/abs/2404.13076";

type Status = "ok" | "watch" | "warn" | "wait" | "note";

const STATUS_WORD: Record<Status, string> = {
  ok: "Looks fine",
  watch: "Worth a look",
  warn: "Watch out",
  wait: "Too early to tell",
  note: "For context",
};

const MINUS = "−";

/** "+0.4", "−0.4", "0.0". */
function signed(x: number, digits = 1): string {
  const s = Math.abs(x).toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return `${x < 0 ? MINUS : "+"}${s}`;
}

/** A difference of two rates in percentage points. */
const points = (d: number) => `${signed(d * 100)} points`;
const pointsAbs = (d: number) => `${(Math.abs(d) * 100).toFixed(1)} points`;

const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

function Cite({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="link" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** Judge check: how far to trust the LLM judge behind the scorecards. */
export function JudgeCheck({ data, summary }: { data: RecordsState; summary?: Summary }) {
  const tolerance = summary?.thresholds.quality_tolerance ?? DEFAULT_TOLERANCE;
  const judged = useMemo(() => judgedRecords(data.records), [data.records]);

  const candidates = useMemo(() => {
    const seen = new Map<string, { key: string; model: string; experiment: string }>();
    for (const r of judged) {
      const key = candidateKey(r);
      if (!seen.has(key)) seen.set(key, { key, model: r.candidate.model, experiment: r.experiment });
    }
    const list = [...seen.values()];
    // Name the experiment only when one model is a candidate in more than one.
    const dup = new Set(list.filter((c, i) => list.findIndex((d) => d.model === c.model) !== i).map((c) => c.model));
    return list.map((c) => ({ ...c, label: dup.has(c.model) ? `${c.model} (${c.experiment})` : c.model }));
  }, [judged]);

  const [scope, setScope] = useState("all");
  const active = scope === "all" || candidates.some((c) => c.key === scope) ? scope : "all";
  const scoped = useMemo(
    () => (active === "all" ? data.records : data.records.filter((r) => candidateKey(r) === active)),
    [data.records, active],
  );

  const overall = useMemo(
    () => ({ position: positionBias(data.records, tolerance), length: verbosity(data.records, tolerance), gaps: scoreGaps(data.records, tolerance), health: judgeHealth(data.records) }),
    [data.records, tolerance],
  );
  const view = useMemo(
    () =>
      active === "all"
        ? overall
        : { position: positionBias(scoped, tolerance), length: verbosity(scoped, tolerance), gaps: scoreGaps(scoped, tolerance), health: judgeHealth(scoped) },
    [active, overall, scoped, tolerance],
  );

  const judgeModel = summary?.judge_model;
  const links = useMemo(() => {
    const models: { model: string; role: FamilyLink["role"] }[] = [];
    for (const e of summary?.experiments ?? []) {
      models.push({ model: modelId(e.source), role: "primary" });
      for (const c of e.candidates) models.push({ model: modelId(c), role: "candidate" });
    }
    for (const r of judged) {
      models.push({ model: modelId(r.primary), role: "primary" });
      models.push({ model: modelId(r.candidate), role: "candidate" });
    }
    return { links: judgeFamilyLinks(judgeModel, models), total: new Set(models.map((m) => `${m.role}|${m.model}`)).size };
  }, [summary, judged, judgeModel]);

  const heading = (
    <div className="lv-head">
      <h1 className="lv-h2" id="judge-h">
        How far to trust the judge
      </h1>
      <p className="muted small">
        Every pass and fail on the scorecards is the verdict of an LLM judge, so this page checks the judge itself: the habits judges are known
        to have, measured on this gateway&rsquo;s traffic, and how often it agrees with you.
      </p>
    </div>
  );

  if (!data.loaded) {
    return (
      <section className="wrap lv-section lv-judge" aria-labelledby="judge-h">
        {heading}
        <p className="lv-empty">{data.error ? `Could not load comparisons: ${data.error}` : "Loading comparisons…"}</p>
      </section>
    );
  }

  if (judged.length === 0 && overall.health.errors === 0) {
    return (
      <section className="wrap lv-section lv-judge" aria-labelledby="judge-h">
        {heading}
        <p className="lv-empty">
          {summary && !judgeModel
            ? "This gateway has no judge configured, so there is nothing to check: pairs are decided by exact match and embedding similarity."
            : "No judged comparisons yet. They appear here as sampled traffic is scored."}
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="wrap lv-section lv-judge" aria-labelledby="judge-h">
        {heading}

        <p className="lv-judge__basis small muted">
          Judge <span className="model">{judgeModel ?? "not reported yet"}</span>, quality tolerance{" "}
          <b className="num">{plural(tolerance, "point")}</b>. Based on the newest {plural(judged.length, "judged comparison")}
          {data.total > data.records.length && <> of {count(data.total)} the gateway holds</>}.
        </p>

        <Glance overall={overall} links={links.links} judgeModel={judgeModel} maxJudgeErrorRate={summary?.thresholds.max_judge_error_rate} />

        {links.links.length > 0 && judgeModel && <FamilyNote judgeModel={judgeModel} links={links.links} />}

        {candidates.length > 1 && (
          <fieldset className="lv-judge__scope">
            <legend className="small">Show</legend>
            {[{ key: "all", label: "All candidates" }, ...candidates].map((c) => (
              <label key={c.key} data-on={active === c.key}>
                <input type="radio" name="judge-scope" value={c.key} checked={active === c.key} onChange={() => setScope(c.key)} />
                <span className={c.key === "all" ? undefined : "model"}>{c.label}</span>
              </label>
            ))}
          </fieldset>
        )}

        <div className="lv-judge__grid">
          <PositionPanel p={view.position} />
          <LengthPanel v={view.length} />
          <GapsPanel g={view.gaps} />
          <HealthPanel h={view.health} limit={summary?.thresholds.max_judge_error_rate} />
        </div>
      </section>
    </>
  );
}

// ---------- at a glance ----------

interface GlanceItem {
  label: string;
  status: Status;
  text: string;
}

function positionStatus(p: PositionBias): { status: Status; text: string } {
  if (!p.enough)
    return {
      status: "wait",
      text: `Needs ${MIN_PER_ARM} verdicts in each order; has ${count(p.first.n)} with the candidate first and ${count(p.second.n)} second.`,
    };
  if (p.flagged)
    return {
      status: p.large ? "warn" : "watch",
      text: `Leans toward the answer shown ${p.favours ?? "in one slot"}${p.large ? ", by 10 points or more" : ", by a few points"}.`,
    };
  return { status: "ok", text: `No clear effect across ${count(p.first.n + p.second.n)} verdicts.` };
}

function lengthStatus(v: Verbosity): { status: Status; text: string } {
  const c = v.correlation;
  if (!c || c.n < 30) return { status: "wait", text: "Too few pairs with text answers to tell." };
  if (excludesZero(c) && Math.abs(c.r) >= 0.2)
    return { status: "watch", text: `${c.r > 0 ? "Longer" : "Shorter"} candidate answers score higher (r = ${signed(c.r, 2)}).` };
  return { status: "ok", text: "No clear link between answer length and score." };
}

function familyStatus(judgeModel: string | undefined, links: FamilyLink[]): { status: Status; text: string } {
  if (!judgeModel) return { status: "wait", text: "The gateway has not reported its judge model yet." };
  if (links.length === 0) {
    return modelFamily(judgeModel)
      ? { status: "ok", text: "From a different family than every model it judges." }
      : { status: "note", text: "Family not recognised; check it is not one of the judged models." };
  }
  const primary = links.find((l) => l.role === "primary" && l.relation === "same model");
  const candidate = links.find((l) => l.role === "candidate" && l.relation === "same model");
  if (candidate) return { status: "warn", text: "The judge is one of the candidates it scores." };
  if (primary) return { status: "watch", text: `It is the primary model${links.length > 1 ? ", and shares a family with the candidates" : ""}.` };
  return { status: "watch", text: `Shares a family with ${plural(links.length, "model")} it judges.` };
}

function Glance({
  overall,
  links,
  judgeModel,
  maxJudgeErrorRate,
}: {
  overall: { position: PositionBias; length: Verbosity; gaps: ScoreGaps; health: JudgeHealth };
  links: FamilyLink[];
  judgeModel?: string;
  maxJudgeErrorRate?: number;
}) {
  const { position, length, gaps, health } = overall;
  const items: GlanceItem[] = [
    { label: "Answer order", ...positionStatus(position) },
    { label: "Answer length", ...lengthStatus(length) },
    { label: "Model family", ...familyStatus(judgeModel, links) },
    {
      label: "Ties",
      status: "note",
      text: gaps.n > 0 ? `${pct(gaps.tieRate, 0)} of pairs got equal scores.` : "No scored pairs yet.",
    },
    {
      label: "Failed calls",
      status:
        health.attempts === 0
          ? "wait"
          : health.errors === 0
            ? "ok"
            : maxJudgeErrorRate !== undefined && (health.rate ?? 0) > maxJudgeErrorRate
              ? "warn"
              : "watch",
      text: health.errors === 0 ? `None in ${plural(health.attempts, "call")}.` : `${pct(health.rate)} of ${plural(health.attempts, "call")} failed.`,
    },
  ];
  return (
    <ul className="lv-judge__glance" aria-label="At a glance">
      {items.map((i) => (
        <li key={i.label} data-status={i.status}>
          <p className="lv-judge__glance-label small">
            <span className="lv-judge__dot" aria-hidden="true" />
            {i.label}
            <span className="sr-only">: {STATUS_WORD[i.status]}.</span>
          </p>
          <p className="small">{i.text}</p>
        </li>
      ))}
    </ul>
  );
}

function FamilyNote({ judgeModel, links }: { judgeModel: string; links: FamilyLink[] }) {
  const family = modelFamily(judgeModel);
  const candidateSelf = links.find((l) => l.role === "candidate" && l.relation === "same model");
  const primarySelf = links.find((l) => l.role === "primary" && l.relation === "same model");
  const kinModels = links.filter((l) => l.relation === "same family").map((l) => l.model.slice(l.model.lastIndexOf("/") + 1));
  const kin = kinModels.map((m, i) => (
    <span key={m}>
      {i > 0 && (i === kinModels.length - 1 ? " and " : ", ")}
      <span className="model">{m}</span>
    </span>
  ));
  return (
    <div className="lv-judge__family" role="note">
      <p>
        <b>
          {candidateSelf ? (
            <>
              The judge, <span className="model">{judgeModel}</span>, is also a candidate it scores.
            </>
          ) : primarySelf ? (
            <>
              The judge, <span className="model">{judgeModel}</span>, is the primary model itself
              {kin.length > 0 && <>{family ? `, and the same ${family} family as ` : ", and the same family as "}{kin}</>}.
            </>
          ) : (
            <>
              The judge, <span className="model">{judgeModel}</span>, is the same {family ? `${family} ` : ""}family as {kin}.
            </>
          )}
        </b>{" "}
        Models tend to rate text from themselves and their own family higher (<Cite href={PANICKSSERY}>Panickssery et al. 2024</Cite>),{" "}
        {candidateSelf
          ? "so this judge may flatter its own answers: the risky direction, since it makes a candidate look better than it is."
          : primarySelf
            ? "so here any self-preference works against the candidates and the scorecard errs strict; a judge from another family would be a more neutral referee."
            : "so a judge from another family would be a more neutral referee."}
      </p>
    </div>
  );
}

// ---------- panels ----------

function Panel({ id, title, status, finding, children, explain }: { id: string; title: string; status: Status; finding: ReactNode; children?: ReactNode; explain: ReactNode }) {
  return (
    <article className="lv-judge__panel" aria-labelledby={id}>
      <h2 className="lv-judge__h3" id={id}>
        {title}
      </h2>
      <p className="lv-judge__finding" data-status={status}>
        <span className="lv-judge__dot" aria-hidden="true" />
        <span>
          <span className="sr-only">{STATUS_WORD[status]}: </span>
          {finding}
        </span>
      </p>
      {children}
      <p className="lv-judge__explain small">{explain}</p>
    </article>
  );
}

const OUTCOMES = [
  { key: "wins", label: "candidate preferred" },
  { key: "ties", label: "tie" },
  { key: "losses", label: "primary preferred" },
] as const;

function ArmBar({ label, arm }: { label: string; arm: PositionArm }) {
  const share = (k: number) => (arm.n > 0 ? k / arm.n : 0);
  return (
    <div className="lv-judge__arm">
      <p className="small">
        {label} <span className="muted num">{plural(arm.n, "verdict")}</span>
      </p>
      <div
        className="lv-judge__stack"
        role="img"
        aria-label={`${label}: candidate preferred ${pct(share(arm.wins))}, tie ${pct(share(arm.ties))}, primary preferred ${pct(share(arm.losses))}`}
      >
        {arm.n > 0 &&
          OUTCOMES.map((o) =>
            arm[o.key] > 0 ? (
              <span key={o.key} data-outcome={o.key} style={{ flexGrow: arm[o.key] }} title={`${o.label}: ${count(arm[o.key])} (${pct(share(arm[o.key]))})`} />
            ) : null,
          )}
      </div>
      <p className="lv-judge__arm-nums small num">
        <span>wins {pct(share(arm.wins))}</span>
        <span>losses {pct(share(arm.losses))}</span>
        <span>passes {pct(share(arm.passes))}</span>
      </p>
    </div>
  );
}

function Legend() {
  return (
    <ul className="lv-judge__legend small" aria-label="Legend">
      {OUTCOMES.map((o) => (
        <li key={o.key}>
          <span className="lv-judge__swatch" data-outcome={o.key} aria-hidden="true" />
          {o.label[0].toUpperCase() + o.label.slice(1)}
        </li>
      ))}
    </ul>
  );
}

const interval = (low: number, high: number, fmt: (x: number) => string) => `95% interval ${fmt(low)} to ${fmt(high)}`;

function PositionPanel({ p }: { p: PositionBias }) {
  const { status } = positionStatus(p);
  let finding: ReactNode;
  if (!p.enough) {
    finding = (
      <>
        Too few verdicts to tell yet: {count(p.first.n)} with the candidate shown first and {count(p.second.n)} shown second. A fair read
        needs {MIN_PER_ARM} in each.
      </>
    );
  } else if (p.flagged) {
    finding = (
      <>
        The judge leans toward the answer it reads {p.favours ?? "in one slot"}: the candidate{" "}
        {p.winGap && excludesZero(p.winGap)
          ? `wins ${pointsAbs(p.winGap.diff)} ${p.winGap.diff > 0 ? "more" : "less"} often when it goes first`
          : `loses ${pointsAbs(p.lossGap!.diff)} ${p.lossGap!.diff > 0 ? "more" : "less"} often when it goes first`}
        , and the 95% interval leaves out zero.
      </>
    );
  } else {
    finding = <>No clear position effect: the candidate fares about the same whichever slot it is shown in.</>;
  }
  return (
    <Panel
      id="judge-position-h"
      title="Does answer order sway it?"
      status={status}
      finding={finding}
      explain={
        <>
          Judges tend to prefer whichever answer they read first (<Cite href={ZHENG}>Zheng et al. 2023</Cite>). RelayProof shows the candidate
          first in a random half of pairs, so a lean like this averages out of the scorecard instead of tilting it, though it adds noise. Worry
          when the gap is clear and large: the judge is then partly scoring position, not quality.
        </>
      }
    >
      <div className="lv-judge__arms">
        <ArmBar label="Candidate shown first" arm={p.first} />
        <ArmBar label="Candidate shown second" arm={p.second} />
      </div>
      <Legend />
      <dl className="lv-judge__facts num">
        <div>
          <dt>Candidate wins, first minus second</dt>
          <dd>
            {p.winGap ? points(p.winGap.diff) : "–"}
            {p.winGap && <small>{interval(p.winGap.low * 100, p.winGap.high * 100, (x) => signed(x))}</small>}
          </dd>
        </div>
        <div>
          <dt>Candidate losses, first minus second</dt>
          <dd>
            {p.lossGap ? points(p.lossGap.diff) : "–"}
            {p.lossGap && <small>{interval(p.lossGap.low * 100, p.lossGap.high * 100, (x) => signed(x))}</small>}
          </dd>
        </div>
        <div>
          <dt>First slot&rsquo;s share of the wins</dt>
          <dd>
            {pct(p.firstSlotShare, 0)}
            <small>
              {p.decisive > 0 ? `of ${plural(p.decisive, "verdict")} that named a winner; 50% is neutral` : "no verdict named a winner yet"}
            </small>
          </dd>
        </div>
      </dl>
    </Panel>
  );
}

function GapBar({ gap, max }: { gap?: number; max: number }) {
  if (gap === undefined) return null;
  const w = Math.min(1, Math.abs(gap) / max) * 50;
  return (
    <span className="lv-judge__div" aria-hidden="true">
      <span data-sign={gap < 0 ? "neg" : "pos"} style={gap < 0 ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }} />
    </span>
  );
}

function LengthPanel({ v }: { v: Verbosity }) {
  const { status } = lengthStatus(v);
  const c = v.correlation;
  const rates = v.buckets.filter((b) => b.n > 0).map((b) => b.passRate ?? 0);
  const flatPass = rates.length > 1 && Math.max(...rates) - Math.min(...rates) < 0.02;
  const maxGap = Math.max(1, ...v.buckets.map((b) => Math.abs(b.meanGap ?? 0)));
  let finding: ReactNode;
  if (!c || c.n < 30) {
    finding = <>Too few judged pairs with text answers to tell yet ({count(v.measured)}; a fair read needs about 30).</>;
  } else if (excludesZero(c) && Math.abs(c.r) >= 0.2) {
    finding = (
      <>
        {c.r > 0 ? "Longer" : "Shorter"} candidate answers scored higher: the score gap {c.r > 0 ? "rises" : "falls"} as the candidate&rsquo;s
        answer grows (r = {signed(c.r, 2)}, {interval(c.low, c.high, (x) => signed(x, 2))}).
        {flatPass && <> Every length group passes at the same rate, so the lean has not changed a verdict yet.</>}
      </>
    );
  } else {
    finding = (
      <>
        No clear link between answer length and score (r = {signed(c.r, 2)}, {interval(c.low, c.high, (x) => signed(x, 2))}).
      </>
    );
  }
  return (
    <Panel
      id="judge-length-h"
      title="Does answer length sway it?"
      status={status}
      finding={finding}
      explain={
        <>
          Length is the candidate&rsquo;s answer divided by the primary&rsquo;s, in characters. Judges tend to reward longer answers (
          <Cite href={ZHENG}>Zheng et al. 2023</Cite>); this one is told not to. A trend either way can also be real: short answers may leave
          things out, long ones may pad. Label a few below before blaming the judge.
          {v.skipped > 0 && <> {plural(v.skipped, "pair")} without primary text, such as tool calls, are left out.</>}
        </>
      }
    >
      <table className="lv-judge__table num">
        <caption className="sr-only">Judge pass rate and mean score gap by candidate answer length</caption>
        <thead>
          <tr>
            <th scope="col">Candidate answer</th>
            <th scope="col">Pairs</th>
            <th scope="col">Pass on judge</th>
            <th scope="col">Mean gap</th>
          </tr>
        </thead>
        <tbody>
          {v.buckets.map((b) => (
            <tr key={b.id}>
              <th scope="row">
                {b.label}
                <small>{b.range}</small>
              </th>
              <td>{count(b.n)}</td>
              <td>
                <span className="lv-judge__cell">
                  <span className="lv-judge__meter" aria-hidden="true">
                    {b.passRate !== undefined && <span style={{ width: `${b.passRate * 100}%` }} />}
                  </span>
                  {b.n > 0 ? pct(b.passRate, 0) : "–"}
                </span>
              </td>
              <td>
                <span className="lv-judge__cell">
                  <GapBar gap={b.meanGap} max={maxGap} />
                  {b.meanGap !== undefined ? signed(b.meanGap) : "–"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Mean gap is candidate score minus primary score, in judge points.</p>
    </Panel>
  );
}

/** Width of an element, kept current. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** A column with a rounded top and a square foot. */
function column(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function Histogram({ g }: { g: ScoreGaps }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = Math.max(280, width);
  const H = 200;
  const pad = { top: 42, right: 6, bottom: 44, left: 6 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const slot = plotW / g.bins.length;
  const barW = Math.min(24, Math.max(6, slot - 4));
  const tie = g.bins[9].n;
  const others = Math.max(0, ...g.bins.filter((b) => b.gap !== 0).map((b) => b.n));
  // A tie bar many times taller than the rest would flatten every disagreement, so it is cut and labelled.
  const clip = others > 0 && tie > 3 * others;
  const yMax = clip ? others * 1.2 : Math.max(1, tie, others);
  const x = (gap: number) => pad.left + (gap + 9) * slot + slot / 2;
  const y = (n: number) => pad.top + plotH - (Math.min(n, yMax) / yMax) * plotH;
  const line = pad.left + (-g.tolerance + 9) * slot; // left edge of the first passing bin
  const ticks = [-9, -6, -3, 0, 3, 6, 9];
  const fmtTick = (t: number) => (t === 0 ? "0" : `${t < 0 ? MINUS : "+"}${Math.abs(t)}`);
  const described = g.bins
    .filter((b) => b.n > 0)
    .map((b) => `${fmtTick(b.gap)}: ${b.n}`)
    .join(", ");
  return (
    <div className="lv-judge__hist" ref={ref}>
      {width > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Score gaps, candidate minus primary. ${described || "none yet"}.`}>
          <rect className="lv-judge__hist-pass" x={line} y={pad.top - 24} width={W - pad.right - line} height={plotH + 24} />
          <line className="lv-judge__hist-base" x1={pad.left} x2={W - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} />
          {g.bins.map((b) => {
            if (b.n === 0) return null;
            const top = y(b.n);
            const h = Math.max(2, pad.top + plotH - top);
            const pass = b.gap >= -g.tolerance;
            const cut = clip && b.gap === 0;
            return (
              <g key={b.gap}>
                <path className="lv-judge__hist-bar" data-pass={pass} d={column(x(b.gap) - barW / 2, pad.top + plotH - h, barW, h)}>
                  <title>
                    {fmtTick(b.gap)}: {plural(b.n, "pair")}
                  </title>
                </path>
                {cut && (
                  <path className="lv-judge__hist-cut" d={`M${x(b.gap) - barW / 2 - 2},${top + 14}l${barW + 4},-6M${x(b.gap) - barW / 2 - 2},${top + 19}l${barW + 4},-6`} />
                )}
                <text className="lv-judge__hist-n" x={x(b.gap)} y={top - 5} textAnchor="middle">
                  {count(b.n)}
                </text>
              </g>
            );
          })}
          <line className="lv-judge__hist-line" x1={line} x2={line} y1={pad.top - 24} y2={pad.top + plotH} />
          <text className="lv-judge__hist-note" x={line - 6} y={pad.top - 28} textAnchor="end">
            Fails
          </text>
          <text className="lv-judge__hist-note" x={line + 6} y={pad.top - 28}>
            Passes, from {fmtTick(-g.tolerance)}
          </text>
          {ticks.map((t) => (
            <text key={t} className="lv-judge__hist-tick" x={x(t)} y={pad.top + plotH + 16} textAnchor="middle">
              {fmtTick(t)}
            </text>
          ))}
          <text className="lv-judge__hist-axis" x={pad.left} y={H - 6}>
            Candidate scored lower
          </text>
          <text className="lv-judge__hist-axis" x={W - pad.right} y={H - 6} textAnchor="end">
            Candidate scored higher
          </text>
        </svg>
      )}
    </div>
  );
}

function GapsPanel({ g }: { g: ScoreGaps }) {
  const fails = g.n - g.passes;
  const status: Status = g.n === 0 ? "wait" : "note";
  return (
    <Panel
      id="judge-gaps-h"
      title="How far apart are the scores?"
      status={status}
      finding={
        g.n === 0 ? (
          <>No scored pairs yet.</>
        ) : (
          <>
            {pct(g.tieRate, 0)} of pairs got equal scores; {fails === 0 ? "none" : pct(fails / g.n, 1)} fell below the pass line. On average the
            candidate scored {signed(g.meanGap ?? 0, 2)} points against the primary.
          </>
        )
      }
      explain={
        <>
          Scores run from 1 to 10, and each bar counts pairs by candidate score minus primary score. A pair passes on the judge when the candidate
          trails by at most {plural(g.tolerance, "point")} (the shaded side). Many ties mean the judge rarely separates the answers; the scorecard
          then measures &ldquo;not visibly worse&rdquo; more than &ldquo;as good&rdquo;, which your own labels below can confirm.
        </>
      }
    >
      <Histogram g={g} />
      <dl className="lv-judge__facts num">
        <div>
          <dt>Tie rate</dt>
          <dd>
            {pct(g.tieRate, 0)}
            <small>
              {count(g.ties)} of {plural(g.n, "pair")}
            </small>
          </dd>
        </div>
        <div>
          <dt>Pass on the judge</dt>
          <dd>
            {pct(g.passRate, 1)}
            <small>{count(g.passes)} at or above the line</small>
          </dd>
        </div>
      </dl>
    </Panel>
  );
}

function HealthPanel({ h, limit }: { h: JudgeHealth; limit?: number }) {
  const over = limit !== undefined && (h.rate ?? 0) > limit;
  const status: Status = h.attempts === 0 ? "wait" : over ? "warn" : h.errors > 0 || h.contradictions > 0 ? "watch" : "ok";
  return (
    <Panel
      id="judge-health-h"
      title="Does the judge hold up?"
      status={status}
      finding={
        h.attempts === 0 ? (
          <>No judge calls yet.</>
        ) : (
          <>
            {h.errors === 0 ? (
              <>Every one of {plural(h.attempts, "judge call")} returned a usable verdict</>
            ) : (
              <>
                {count(h.errors)} of {plural(h.attempts, "judge call")} failed ({pct(h.rate)})
                {limit !== undefined && <>{over ? ", above" : ", within"} the {pct(limit, 0)} the scorecard allows</>}
              </>
            )}
            {h.judged > 0 &&
              (h.contradictions === 0 ? (
                <>, and no verdict contradicts its own scores.</>
              ) : (
                <>
                  ; {plural(h.contradictions, "verdict")} named as winner the answer its own scores ranked lower.
                </>
              ))}
          </>
        )
      }
      explain={
        <>
          A failed call leaves the pair unscored rather than letting a weaker signal decide, so failures slow a verdict down but cannot pass a
          candidate.
          {limit !== undefined && <> Above {pct(limit, 0)} the scorecard marks the candidate not ready.</>} A rising rate usually means the judge
          model is rate limited, timing out or replying in the wrong format. A verdict that contradicts its own scores is a sign of a careless
          judge; the plugin goes by the scores.
        </>
      }
    >
      <dl className="lv-judge__facts lv-judge__facts--big num">
        <div>
          <dt>Failed judge calls</dt>
          <dd>
            {pct(h.rate ?? 0, 1)}
            <small>
              {count(h.errors)} of {plural(h.attempts, "call")}
            </small>
          </dd>
        </div>
        <div>
          <dt>Verdicts that contradict their scores</dt>
          <dd>
            {h.judged > 0 ? pct(h.contradictions / h.judged, 1) : "–"}
            <small>
              {count(h.contradictions)} of {plural(h.judged, "verdict")}
            </small>
          </dd>
        </div>
      </dl>
      {h.messages.length > 0 && (
        <div className="lv-judge__errors">
          <p className="small muted">Most recent failures</p>
          <ul className="small">
            {h.messages.map((m) => (
              <li key={m}>
                <code>{m}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
