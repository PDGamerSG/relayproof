import { useMemo } from "react";
import { count, modelId, ms, pct } from "./backend";
import { DRIFT_WINDOW, MIN_WINDOW, driftAll, type Drift, type DriftStatus, type DriftWindow } from "./drift";
import { eventsFor, type RecordsState } from "./records";
import type { PairSummary, RolloutEvent, Summary } from "./shadowClient";
import "./drift.css";

const STATUS_LABEL: Record<DriftStatus, string> = {
  steady: "Steady",
  worse: "Getting worse",
  better: "Getting better",
  thin: "Too little data",
};

const EVENT_LABEL: Record<RolloutEvent["action"], string> = {
  promote: "promoted",
  rollback: "rolled back",
  auto_rollback: "guard rolled back",
};

/** Percentage points with a real minus sign: 0.081 -> "+8.1". */
function points(diff: number, digits = 1): string {
  const v = diff * 100;
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return s;
  return `${v < 0 ? "−" : "+"}${s}`;
}

const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

/** Size of a change in points, without a sign: 0.081 -> "8.1". */
const size = (diff: number) => Math.abs(diff * 100).toFixed(1);

const day = (t: number) => new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** When a window ran: "14:02–14:20" today, "13 Nov, 14:02–14:20" on another day, "13 Nov–14 Nov" across days. */
function span(from: number, to: number, now: number): string {
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
  if (!sameDay) return `${day(from)}–${day(to)}`;
  const today = new Date(from).toDateString() === new Date(now).toDateString();
  return `${today ? "" : `${day(from)}, `}${time(from)}–${time(to)}`;
}

/**
 * Drift watch: per candidate, the newest window of counted comparisons against
 * the window before it. A candidate that was ready can get worse later, after a
 * provider update or a shift in traffic; the running agreement on the scorecard
 * is slow to show that, because it averages over everything loaded.
 */
export function DriftWatch({ data, summary, events }: { data: RecordsState; summary?: Summary; events?: RolloutEvent[] }) {
  const drifts = useMemo(() => driftAll(data.records, summary?.pairs), [data.records, summary?.pairs]);
  if (!data.loaded || data.records.length === 0 || drifts.length === 0) return null;

  const minAgreement = summary?.thresholds.min_agreement ?? 0.9;
  const multi = (summary?.experiments.length ?? 1) > 1;
  const pairOf = (d: Drift) => summary?.pairs.find((p) => p.experiment === d.experiment && modelId(p.candidate) === modelId(d.candidate));
  const partial = data.total > data.records.length;
  const worse = drifts.filter((d) => d.status === "worse").length;

  return (
    <section className="wrap lv-section lv-drift" aria-labelledby="drift-h">
      <div className="lv-head">
        <h2 className="lv-h2" id="drift-h">
          Drift watch
        </h2>
        <p className="muted small">
          A candidate that cleared the bar can get worse later, after a provider update or a change in what people ask. Each row sets a
          candidate&rsquo;s newest {DRIFT_WINDOW} counted comparisons against the {DRIFT_WINDOW} before them. It says getting worse only when
          the whole 95% range of the change sits below zero, so chance is an unlikely explanation; that is the moment to read the recent
          disagreements.
        </p>
      </div>

      <p className="sr-only" role="status">
        {worse > 0 ? `${plural(worse, "candidate")} getting worse.` : "No candidate is getting worse."}
      </p>

      <ul className="lv-drift__list">
        {drifts.map((d) => (
          <DriftRow
            key={d.key}
            drift={d}
            pair={pairOf(d)}
            experiment={multi ? d.experiment : undefined}
            minAgreement={minAgreement}
            events={eventsFor(events, d.experiment, modelId(d.candidate))}
            now={Date.now()}
          />
        ))}
      </ul>

      <p className="lv-drift__foot small muted">
        Counted comparisons are scored pairs and candidate errors, as on the scorecards; an error counts as a disagreement. Windows come
        from the newest {count(data.records.length)} comparisons loaded in this browser
        {partial ? `; the gateway holds ${count(data.total)}` : ""}.
      </p>
    </section>
  );
}

function sentence(d: Drift, pair?: PairSummary): string {
  const c = d.change;
  if (d.status === "thin" || !c || !d.recent) {
    const need = 2 * MIN_WINDOW;
    return `${plural(d.counted, "counted comparison")} loaded. Drift needs at least ${need}, ${MIN_WINDOW} in each window, before a change can be told from chance.`;
  }
  const range = `${points(c.low)} to ${points(c.high)} points`;
  if (d.status === "worse") {
    const still = pair?.verdict === "ready" ? " The scorecard still says Ready because it averages over everything; a recent drop takes a while to move it." : "";
    return `Agreement in the newest ${d.size} is ${size(c.diff)} points lower, and the 95% range of the change (${range}) is all below zero.${still} Read the recent disagreements.`;
  }
  if (d.status === "better") {
    return `Agreement in the newest ${d.size} is ${size(c.diff)} points higher, and the 95% range of the change (${range}) is all above zero.`;
  }
  const hide = c.low < -0.01 ? ` A drop of up to ${Math.round(-c.low * 100)} points could still hide in windows of ${d.size}.` : "";
  return `No clear change: the 95% range of the change runs from ${range}, which includes zero.${hide}`;
}

function DriftRow({
  drift: d,
  pair,
  experiment,
  minAgreement,
  events,
  now,
}: {
  drift: Drift;
  pair?: PairSummary;
  experiment?: string;
  minAgreement: number;
  events: RolloutEvent[];
  now: number;
}) {
  return (
    <li className="lv-drift__row" data-status={d.status}>
      <div className="lv-drift__who">
        <p className="lv-drift__title">
          <span className="model">{modelId(d.candidate)}</span>
          {experiment && <span className="small muted"> in {experiment}</span>}
        </p>
        <p className="lv-drift__status" data-status={d.status}>
          {STATUS_LABEL[d.status]}
        </p>
        <p className="lv-drift__say small">{sentence(d, pair)}</p>
        {d.shrunk && d.size > 0 && (
          <p className="lv-drift__note small muted">
            Only {plural(d.counted, "counted comparison")} loaded, so each window holds {d.size} instead of {DRIFT_WINDOW}. Smaller windows
            give wider ranges.
          </p>
        )}
      </div>

      <Spark drift={d} minAgreement={minAgreement} events={events} />

      {d.before && d.recent && d.change ? (
        <div className="lv-drift__nums">
          <table className="lv-drift__table num">
            <caption className="sr-only">Earlier and newest window for {modelId(d.candidate)}</caption>
            <thead>
              <tr>
                <td />
                <th scope="col">
                  Earlier {d.size}
                  <small>{span(d.before.from, d.before.to, now)}</small>
                </th>
                <th scope="col">
                  Newest {d.size}
                  <small>{span(d.recent.from, d.recent.to, now)}</small>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">
                  Agreement
                  <small>share that passed, with its 95% range</small>
                </th>
                <WindowCell w={d.before} />
                <WindowCell w={d.recent} />
              </tr>
              <tr>
                <th scope="row">
                  Candidate errors
                  <small>calls that failed outright</small>
                </th>
                <td>
                  {pct(d.before.errorRate)}
                  <small>{plural(d.before.errors, "error")}</small>
                </td>
                <td>
                  {pct(d.recent.errorRate)}
                  <small>{plural(d.recent.errors, "error")}</small>
                </td>
              </tr>
              <tr>
                <th scope="row">
                  Latency p50
                  <small>half the answers came faster</small>
                </th>
                <td>{ms(d.before.p50)}</td>
                <td>{ms(d.recent.p50)}</td>
              </tr>
            </tbody>
          </table>
          <p className="lv-drift__change small">
            <span className="muted">Change in agreement</span> <b className="num">{points(d.change.diff)} points</b>{" "}
            <span className="muted num">
              95% range {points(d.change.low)} to {points(d.change.high)}
            </span>
          </p>
        </div>
      ) : (
        <div className="lv-drift__nums" />
      )}
    </li>
  );
}

function WindowCell({ w }: { w: DriftWindow }) {
  return (
    <td>
      <span className="lv-drift__rate">{pct(w.agreement)}</span>
      <small>
        {count(w.passes)} of {count(w.n)}
        <br />
        range {Math.round(w.interval.low * 100)}–{pct(w.interval.high, 0)}
      </small>
    </td>
  );
}

const W = 340;
const H = 124;
const PAD = { top: 10, right: 6, bottom: 18, left: 6 };

/** Rolling agreement over the counted comparisons, the two windows shaded and rollout events marked. */
function Spark({ drift: d, minAgreement, events }: { drift: Drift; minAgreement: number; events: RolloutEvent[] }) {
  if (d.rolling.length < 2) {
    return (
      <div className="lv-drift__spark lv-drift__spark--empty">
        <p className="small muted">The line appears after {plural(d.rollWidth || 7, "counted comparison")}.</p>
      </div>
    );
  }
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const lowest = Math.min(minAgreement, ...d.rolling.map((p) => p.agreement));
  const yMin = lowest < 0.5 ? 0 : 0.5;
  // Comparison k (from 0) spans edge(k) to edge(k + 1).
  const edge = (k: number) => PAD.left + (k / d.counted) * plotW;
  const cx = (n: number) => edge(n - 0.5);
  const y = (v: number) => PAD.top + (1 - (Math.max(yMin, Math.min(1, v)) - yMin) / (1 - yMin)) * plotH;
  const path = d.rolling.map((p, i) => `${i === 0 ? "M" : "L"}${cx(p.n).toFixed(1)},${y(p.agreement).toFixed(1)}`).join("");
  const marks = events
    .map((e) => {
      const at = Date.parse(e.at);
      if (at < d.times[0]) return undefined;
      const k = d.times.findIndex((t) => t >= at);
      return { e, k: k < 0 ? d.counted : k };
    })
    .filter((m): m is { e: RolloutEvent; k: number } => m !== undefined);
  const last = d.rolling[d.rolling.length - 1];
  const label =
    `Rolling agreement over ${d.rollWidth} comparisons, now ${pct(last.agreement, 0)}` +
    (d.before && d.recent ? `; earlier window ${pct(d.before.agreement, 0)}, newest ${pct(d.recent.agreement, 0)}` : "") +
    (marks.length ? `; ${marks.map((m) => EVENT_LABEL[m.e.action]).join(", ")} along the way.` : ".");

  return (
    <figure className="lv-drift__spark">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        {d.before && d.recent && (
          <>
            <rect className="lv-drift__band" data-window="before" x={edge(d.before.first - 1)} width={edge(d.before.last) - edge(d.before.first - 1)} y={PAD.top} height={plotH} />
            <rect className="lv-drift__band" data-window="recent" x={edge(d.recent.first - 1)} width={edge(d.recent.last) - edge(d.recent.first - 1)} y={PAD.top} height={plotH} />
            <line className="lv-drift__level" x1={edge(d.before.first - 1)} x2={edge(d.before.last)} y1={y(d.before.agreement)} y2={y(d.before.agreement)} />
            <line className="lv-drift__level" x1={edge(d.recent.first - 1)} x2={edge(d.recent.last)} y1={y(d.recent.agreement)} y2={y(d.recent.agreement)} />
            <text className="lv-drift__axis" x={edge(d.before.first - 1) + 4} y={H - 5}>
              earlier
            </text>
            <text className="lv-drift__axis" x={edge(d.recent.last) - 4} y={H - 5} textAnchor="end">
              newest
            </text>
          </>
        )}
        <line className="lv-drift__need" x1={PAD.left} x2={W - PAD.right} y1={y(minAgreement)} y2={y(minAgreement)} />
        <text className="lv-drift__axis" x={PAD.left + 2} y={y(minAgreement) - 4}>
          needs {pct(minAgreement, 0)}
        </text>
        {marks.map(({ e, k }) => (
          <g key={e.id} className="lv-drift__event" data-action={e.action}>
            <line x1={edge(k)} x2={edge(k)} y1={PAD.top - 4} y2={PAD.top + plotH} />
            <title>
              {EVENT_LABEL[e.action]}
              {e.action === "promote" ? ` to ${pct(e.weight, 0)}` : ""}
            </title>
          </g>
        ))}
        <path className="lv-drift__line" d={path} />
        <circle className="lv-drift__dot" cx={cx(last.n)} cy={y(last.agreement)} r={3} />
      </svg>
      <figcaption className="small muted">
        Rolling agreement, {d.rollWidth} comparisons at a time
        {marks.length > 0 && (
          <>
            ; <span className="lv-drift__key">rollout events</span>
          </>
        )}
      </figcaption>
    </figure>
  );
}
