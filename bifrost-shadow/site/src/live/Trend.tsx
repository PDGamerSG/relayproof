import { useId } from "react";
import { modelId, pct } from "./backend";
import { agreementSeries, candidateKey, eventsFor, type RecordsState } from "./records";
import type { PairSummary, RolloutEvent } from "./shadowClient";

const W = 640;
const PAD = { top: 14, right: 12, bottom: 34, left: 40 };

const EVENT_LABEL: Record<RolloutEvent["action"], string> = {
  promote: "promoted",
  rollback: "rolled back",
  auto_rollback: "guard rolled back",
};

/**
 * Agreement as evidence accumulates: the running agreement rate, its 95%
 * Wilson lower bound and the bar it has to clear, with one tick per comparison
 * along the bottom and the rollout events that happened along the way.
 */
export function Trend({
  data,
  pair,
  minAgreement,
  events,
  height = 168,
}: {
  data: RecordsState;
  pair: PairSummary;
  minAgreement: number;
  events?: RolloutEvent[];
  height?: number;
}) {
  const clipId = useId();
  const series = agreementSeries(data.records, candidateKey(pair));
  if (!data.loaded) return <p className="lv-trend__empty small muted">Loading the comparisons…</p>;
  if (series.length < 3) return <p className="lv-trend__empty small muted">The trend appears after a few scored comparisons.</p>;

  const H = height;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const yMin = 0.5;
  const last = series[series.length - 1];
  const x = (i: number) => PAD.left + (series.length === 1 ? plotW : (i / (series.length - 1)) * plotW);
  const y = (v: number) => PAD.top + (1 - (Math.max(yMin, Math.min(1, v)) - yMin) / (1 - yMin)) * plotH;
  const line = (pick: (p: (typeof series)[number]) => number) =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join("");
  const band =
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.agreement).toFixed(1)}`).join("") +
    [...series]
      .reverse()
      .map((p, j) => `L${x(series.length - 1 - j).toFixed(1)},${y(p.lower).toFixed(1)}`)
      .join("") +
    "Z";

  const cleared = series.findIndex((p) => p.lower >= minAgreement);
  const marks = eventsFor(events, pair.experiment, modelId(pair.candidate))
    .map((e) => {
      const at = Date.parse(e.at);
      const i = series.findIndex((p) => p.at >= at);
      return i < 0 ? undefined : { e, i };
    })
    .filter((m): m is { e: RolloutEvent; i: number } => m !== undefined);
  const partial = data.total > data.records.length;
  const fails = series.filter((p) => !p.pass).length;
  const tickW = Math.max(1, plotW / series.length - 0.6);

  const summary =
    `Running agreement ${pct(last.agreement)} over ${last.n} comparisons, 95% lower bound ${pct(last.lower)}` +
    (cleared >= 0 ? `, cleared ${pct(minAgreement, 0)} at comparison ${series[cleared].n}.` : `, not yet above ${pct(minAgreement, 0)}.`);

  return (
    <figure className="lv-trend">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD.left} y={PAD.top - 2} width={plotW} height={plotH + 4} />
          </clipPath>
        </defs>
        {[0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line className="lv-trend__grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="lv-trend__axis" x={PAD.left - 8} y={y(v) + 4} textAnchor="end">
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        <line className="lv-trend__need" x1={PAD.left} x2={W - PAD.right} y1={y(minAgreement)} y2={y(minAgreement)} />
        <text className="lv-trend__need-label" x={W - PAD.right} y={y(minAgreement) - 5} textAnchor="end">
          needs {pct(minAgreement, 0)}
        </text>
        <g clipPath={`url(#${clipId})`}>
          <path className="lv-trend__band" d={band} />
          <path className="lv-trend__lower" d={line((p) => p.lower)} />
          <path className="lv-trend__rate" d={line((p) => p.agreement)} />
        </g>
        {marks.map(({ e, i }) => (
          <g key={e.id} className="lv-trend__event" data-action={e.action}>
            <line x1={x(i)} x2={x(i)} y1={PAD.top} y2={PAD.top + plotH} />
            <text x={x(i) + 4} y={PAD.top + 10}>
              {EVENT_LABEL[e.action]}
              {e.action === "promote" ? ` ${pct(e.weight, 0)}` : ""}
            </text>
          </g>
        ))}
        {cleared >= 0 && (
          <g className="lv-trend__cleared">
            <circle cx={x(cleared)} cy={y(series[cleared].lower)} r={4} />
            <text
              x={x(cleared) + (cleared > series.length * 0.7 ? -8 : 8)}
              y={y(series[cleared].lower) + 16}
              textAnchor={cleared > series.length * 0.7 ? "end" : "start"}
            >
              ready at {series[cleared].n}
            </text>
          </g>
        )}
        {series.map((p, i) => (
          <rect
            key={p.n}
            className="lv-trend__tick"
            data-outcome={p.error ? "error" : p.pass ? "pass" : "fail"}
            x={x(i) - tickW / 2}
            y={H - PAD.bottom + 10}
            width={tickW}
            height={p.pass ? 6 : 12}
          />
        ))}
        <text className="lv-trend__axis" x={PAD.left} y={H - 4}>
          {partial ? `last ${series.length} loaded` : "first comparison"}
        </text>
        <text className="lv-trend__axis" x={W - PAD.right} y={H - 4} textAnchor="end">
          {last.n} scored{fails > 0 ? `, ${fails} failed` : ""}
        </text>
      </svg>
      <figcaption className="lv-trend__legend small muted">
        <span data-key="rate">Agreement</span>
        <span data-key="lower">95% lower bound</span>
        <span data-key="tick">One tick per comparison; tall = failed</span>
      </figcaption>
    </figure>
  );
}
