import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { count, ms, pct } from "./backend";
import {
  analyse,
  bestCandidate,
  ecdfAt,
  humanDays,
  logTicks,
  niceCeil,
  niceTicks,
  payback,
  QUIET_WIDTH,
  quantile,
  ratio,
  requestRate,
  span,
  spread,
  stepWords,
  tokens,
  traffic,
  trustworthyAt,
  usd,
  type Bucket,
  type Payback,
  type Perf,
  type Rate,
  type Series,
} from "./perf";
import { candidateKey, type RecordsState } from "./records";
import type { ShadowRecord, Summary, Verdict } from "./shadowClient";
import "./performance.css";

/** Below this many requests the charts would mostly show noise. */
const MIN_REQUESTS = 5;

const VERDICT_LABEL: Record<Verdict, string> = {
  collecting: "Collecting",
  promising: "Promising",
  ready: "Ready",
  not_ready: "Not ready",
};

/** Width of an element, kept current as the layout changes. */
function useWidth(): [(el: HTMLElement | null) => (() => void) | undefined, number] {
  const [width, setWidth] = useState(0);
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return undefined;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    const ro = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const minus = (v: number) => (v < 0 ? "−" : v > 0 ? "+" : "±");
const signedMs = (v: number | undefined) => (v === undefined ? "–" : `${minus(Math.round(v))}${ms(Math.abs(v))}`);
const tickMs = (v: number) => (v === 0 ? "0" : v >= 1000 ? `${+(v / 1000).toFixed(2)} s` : `${v} ms`);
/** Axis dollars with only the digits the tick needs: $0.00001, $0.25, $2. */
function tickUsd(v: number): string {
  if (v === 0) return "$0";
  if (v >= 1) return usd(v);
  let d = Math.max(v >= 0.01 ? 2 : 0, Math.ceil(-Math.log10(v)));
  while (d < 10 && Number(v.toFixed(d)) !== v) d++;
  return `$${v.toFixed(d)}`;
}
const perDayUsd = (v: number | undefined) => (v === undefined ? "–" : `${usd(v)} a day`);

function Swatch({ slot, kind = "line" }: { slot: number; kind?: "line" | "dot" }) {
  return <i className="lv-pf__sw" data-slot={Math.min(slot, 4)} data-kind={kind} aria-hidden="true" />;
}

function ModelName({ series, role = false }: { series: Series; role?: boolean }) {
  return (
    <span className="lv-pf__name">
      <Swatch slot={series.slot} kind="dot" />
      <span className="model">{series.model}</span>
      {role && <span className="lv-pf__role">{series.role === "primary" ? "primary" : "candidate"}</span>}
    </span>
  );
}

function Key({ series }: { series: Series[] }) {
  return (
    <ul className="lv-pf__key small">
      {series.map((s) => (
        <li key={s.key}>
          <Swatch slot={s.slot} />
          <span className="model">{s.model}</span>
          <span className="lv-pf__role">{s.role === "primary" ? "primary, what users waited for" : "candidate, in the shadow"}</span>
        </li>
      ))}
    </ul>
  );
}

function Cell({ title, note, children, className = "" }: { title: string; note?: ReactNode; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={`lv-pf__cell ${className}`} role="group" aria-labelledby={id}>
      <h3 className="lv-pf__h3" id={id}>
        {title}
      </h3>
      {note && <p className="lv-pf__note small">{note}</p>}
      {children}
    </div>
  );
}

// ---------- the page ----------

export function Performance({ data, summary }: { data: RecordsState; summary?: Summary }) {
  const perf = useMemo(() => analyse(data.records, summary), [data.records, summary]);
  const rate = useMemo(() => requestRate(perf, summary), [perf, summary]);
  const paybacks = useMemo(() => payback(perf, rate), [perf, rate]);
  const best = useMemo(() => bestCandidate(perf, paybacks), [perf, paybacks]);
  const partial = data.total > data.records.length;

  let body: ReactNode;
  if (!data.loaded)
    body = <p className="lv-empty">{data.error ? `Could not load the comparisons. ${data.error}` : "Loading the comparisons…"}</p>;
  else if (perf.requests < MIN_REQUESTS)
    body = (
      <div className="lv-pf__empty">
        <p className="lv-pf__h3">{perf.requests === 0 ? "No comparisons yet" : `${count(perf.requests)} of ${MIN_REQUESTS} requests so far`}</p>
        <p className="muted small">
          Latency, verbosity, cost and payback appear once a few sampled requests have been replayed against a candidate. Each request
          the gateway samples adds one comparison per candidate; this page refreshes on its own.
        </p>
      </div>
    );
  else
    body = (
      <>
        <Readout perf={perf} best={best} />
        <LatencySection perf={perf} />
        <TokensSection perf={perf} />
        <CostSection perf={perf} />
        <PaybackSection perf={perf} rate={rate} paybacks={paybacks} best={best} summary={summary} partial={partial} total={data.total} />
        <FrontierSection perf={perf} summary={summary} />
        <TrafficSection records={data.records} perf={perf} />
      </>
    );

  return (
    <section className="wrap lv-section lv-pf" aria-labelledby="perf-h">
      <div className="lv-head">
        <h1 className="lv-h2" id="perf-h">
          Performance
        </h1>
        <p className="muted small">
          Is the cheaper model also fast and cheap enough on this traffic, and does shadowing pay for itself? Everything here is measured
          on the {partial ? `newest ${count(data.records.length)} of ${count(data.total)}` : count(data.records.length)} comparisons
          {perf.requests > 0 && <> from {count(perf.requests)} requests</>}
          {perf.first !== undefined && perf.last !== undefined && perf.last > perf.first && <> over {span(perf.last - perf.first)}</>}.
        </p>
      </div>
      {data.loaded && data.error && <p className="lv-pf__stale small">Showing the last comparisons loaded; refreshing failed: {data.error}</p>}
      {body}
    </section>
  );
}

// ---------- at a glance ----------

function Readout({ perf, best }: { perf: Perf; best?: { payback: Payback; ready: boolean } }) {
  const cands = perf.series.filter((s) => s.role === "candidate");
  const primary = perf.series.find((s) => s.role === "primary");
  // The candidate that saves the most time per request.
  const fastest = cands
    .map((s) => ({ s, p: perf.paired.get(s.key) }))
    .filter((x) => x.p && x.p.n > 0)
    .sort((a, b) => quantile(a.p!.diffs, 0.5)! - quantile(b.p!.diffs, 0.5)!)[0];
  const bestSeries = best && perf.series.find((s) => s.key === best.payback.key);
  const bestStats = best && perf.candidates.get(best.payback.key);
  const verbose = cands
    .map((s) => ({ s, t: perf.tokenTotals.get(s.key) }))
    .filter((x) => x.t && x.t.primary > 0)
    .map((x) => ({ s: x.s, r: x.t!.candidate / x.t!.primary }));

  return (
    <dl className="lv-pf__readout" aria-label="At a glance">
      <div>
        <dt>Latency, paired</dt>
        {fastest ? (
          <>
            <dd className="lv-pf__big num">{signedMs(quantile(fastest.p!.diffs, 0.5))}</dd>
            <dd className="small muted">
              <span className="model">{fastest.s.model}</span> beat the primary on {pct(fastest.p!.faster / fastest.p!.n, 0)} of{" "}
              {count(fastest.p!.n)} requests; median difference shown.
            </dd>
          </>
        ) : (
          <dd className="small muted">No request has both latencies yet.</dd>
        )}
      </div>
      <div>
        <dt>Output length</dt>
        {verbose.length ? (
          <>
            <dd className="lv-pf__big num">
              {verbose.length === 1
                ? ratio(verbose[0].r)
                : `${ratio(Math.min(...verbose.map((v) => v.r)))}–${ratio(Math.max(...verbose.map((v) => v.r)))}`}
            </dd>
            <dd className="small muted">
              {verbose.length === 1 ? "The candidate writes" : "Candidates write"} this many output tokens for each one{" "}
              {primary ? <span className="model">{primary.model}</span> : "the primary"} writes, in total.
            </dd>
          </>
        ) : (
          <dd className="small muted">No completed candidate answers yet.</dd>
        )}
      </div>
      <div>
        <dt>Cost per request</dt>
        {bestStats && bestSeries && bestStats.avgPrimaryCost ? (
          <>
            <dd className="lv-pf__big num">{minus(-1)}{pct(1 - bestStats.avgCandidateCost! / bestStats.avgPrimaryCost, 0)}</dd>
            <dd className="small muted">
              <span className="model">{bestSeries.model}</span>
              {best!.ready ? ", the best ready candidate," : ", not ready yet,"} costs {usd(bestStats.avgCandidateCost)} against{" "}
              {usd(bestStats.avgPrimaryCost)}.
            </dd>
          </>
        ) : (
          <dd className="small muted">No candidate is cheaper than the primary on this traffic.</dd>
        )}
      </div>
      <div>
        <dt>Shadowing pays back in</dt>
        {best?.payback.breakEvenDays !== undefined ? (
          <>
            <dd className="lv-pf__big num">{humanDays(best.payback.breakEvenDays).replace(/^about /, "")}</dd>
            <dd className="small muted">
              of traffic on <span className="model">{bestSeries?.model}</span>
              {best.ready ? "" : " (a what-if: not ready)"} repays what these comparisons cost. The assumptions are spelled out below.
            </dd>
          </>
        ) : (
          <dd className="small muted">Needs a candidate that saves money and a measurable request rate.</dd>
        )}
      </div>
    </dl>
  );
}

// ---------- latency ----------

function LatencySection({ perf }: { perf: Perf }) {
  const rows = perf.series.map((s) => ({ series: s, values: perf.latency.get(s.key) ?? [] })).filter((r) => r.values.length > 0);
  const errors = [...perf.errors.values()].reduce((a, b) => a + b, 0);
  return (
    <section className="lv-pf__sec" aria-labelledby="pf-lat-h">
      <div className="lv-pf__head">
        <h2 className="lv-pf__h2" id="pf-lat-h">
          Latency
        </h2>
        <p className="muted small">
          The primary&rsquo;s latency is what users waited for. Candidate latency is measured off the request path, after the answer was
          sent, and candidates are always called without streaming, so compare totals rather than time to first token.
          {errors > 0 && (
            <>
              {" "}
              {count(errors)} candidate {errors === 1 ? "call" : "calls"} that errored {errors === 1 ? "is" : "are"} left out of the
              latency figures.
            </>
          )}
        </p>
      </div>
      <div className="lv-pf__sheet lv-pf__sheet--lat">
        <Cell
          title="How long requests took"
          note="Each line climbs to the share of requests answered within the time on the axis. Further left is faster."
          className="lv-pf__cell--chart"
        >
          <Ecdf rows={rows} />
        </Cell>
        <div className="lv-pf__stack">
          <Cell title="Percentiles">
            <PercentileTable rows={rows} perf={perf} />
          </Cell>
          <Cell title="Same request, head to head" note="Only requests where both the primary and the candidate answered.">
            <PairedList perf={perf} />
          </Cell>
        </div>
      </div>
    </section>
  );
}

function Ecdf({ rows }: { rows: { series: Series; values: number[] }[] }) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState<number>();
  const clip = useId();
  const H = W < 520 ? 240 : 290;
  const PAD = { top: 12, right: 16, bottom: 44, left: 44 };
  const plotW = Math.max(10, W - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const p99 = Math.max(...rows.map((r) => quantile(r.values, 0.99) ?? 0));
  const xMax = niceCeil(p99 * 1.04);
  const beyond = rows.reduce((n, r) => n + r.values.filter((v) => v > xMax).length, 0);
  const x = (v: number) => PAD.left + (Math.min(v, xMax) / xMax) * plotW;
  const y = (f: number) => PAD.top + (1 - f) * plotH;
  const path = (vals: number[]) => {
    let d = `M${x(0).toFixed(1)},${y(0).toFixed(1)}`;
    vals.forEach((v, i) => {
      d += `H${x(v).toFixed(1)}V${y((i + 1) / vals.length).toFixed(1)}`;
    });
    return d + `H${x(xMax).toFixed(1)}`;
  };
  const label =
    "Cumulative latency by model. Medians: " +
    rows.map((r) => `${r.series.model} ${ms(quantile(r.values, 0.5))}`).join(", ") +
    ". 95th percentiles: " +
    rows.map((r) => `${r.series.model} ${ms(quantile(r.values, 0.95))}`).join(", ") +
    ".";

  return (
    <figure className="lv-pf__fig">
      <div className="lv-pf__plot" ref={ref} style={{ height: H }}>
        {W > 0 && (
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={label}
            onPointerMove={(e) => {
              const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
              if (px < PAD.left || px > PAD.left + plotW) return setHover(undefined);
              setHover(((px - PAD.left) / plotW) * xMax);
            }}
            onPointerLeave={() => setHover(undefined)}
          >
            <defs>
              <clipPath id={clip}>
                <rect x={PAD.left} y={PAD.top - 3} width={plotW + 1} height={plotH + 6} />
              </clipPath>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((f) => (
              <g key={f}>
                <line className="lv-pf__grid" data-strong={f === 0 || f === 0.5 || undefined} x1={PAD.left} x2={PAD.left + plotW} y1={y(f)} y2={y(f)} />
                <text className="lv-pf__axis" x={PAD.left - 8} y={y(f) + 4} textAnchor="end">
                  {f * 100}%
                </text>
              </g>
            ))}
            {niceTicks(0, xMax, W < 520 ? 3 : 5).map((v) => (
              <g key={v}>
                <line className="lv-pf__tick" x1={x(v)} x2={x(v)} y1={PAD.top + plotH} y2={PAD.top + plotH + 5} />
                <text className="lv-pf__axis" x={x(v)} y={PAD.top + plotH + 18} textAnchor={v === 0 ? "start" : "middle"}>
                  {tickMs(v)}
                </text>
              </g>
            ))}
            <text className="lv-pf__axis-title" x={PAD.left + plotW} y={H - 4} textAnchor="end">
              time to the full answer{beyond > 0 ? `, ${count(beyond)} slower beyond the edge` : ""}
            </text>
            <g clipPath={`url(#${clip})`}>
              {/* The primary last, so the line users experienced sits on top. */}
              {[...rows].reverse().map((r) => (
                <g key={r.series.key} data-slot={Math.min(r.series.slot, 4)}>
                  <path className="lv-pf__halo" d={path(r.values)} />
                  <path className="lv-pf__line" d={path(r.values)} />
                </g>
              ))}
            </g>
            {rows.map((r) => {
              const m = quantile(r.values, 0.5)!;
              return <circle key={r.series.key} className="lv-pf__dot" data-slot={Math.min(r.series.slot, 4)} cx={x(m)} cy={y(0.5)} r={4.5} />;
            })}
            {hover !== undefined && (
              <g className="lv-pf__hover" aria-hidden="true">
                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />
                {rows.map((r) => (
                  <circle key={r.series.key} className="lv-pf__dot" data-slot={Math.min(r.series.slot, 4)} cx={x(hover)} cy={y(ecdfAt(r.values, hover))} r={4} />
                ))}
              </g>
            )}
          </svg>
        )}
      </div>
      <figcaption>
        <Key series={rows.map((r) => r.series)} />
        <p className="lv-pf__hoverline small" aria-hidden="true">
          {hover === undefined ? (
            <span className="muted">Dots mark each median. Point at the chart to read every model at one latency.</span>
          ) : (
            <>
              <b className="num">Within {ms(hover)}:</b>{" "}
              {rows.map((r, i) => (
                <span key={r.series.key}>
                  {i > 0 && " · "}
                  <span className="model">{r.series.model}</span> <span className="num">{pct(ecdfAt(r.values, hover), 0)}</span>
                </span>
              ))}
            </>
          )}
        </p>
      </figcaption>
    </figure>
  );
}

const PERCENTILES = [
  { p: 0.5, label: "p50" },
  { p: 0.9, label: "p90" },
  { p: 0.95, label: "p95" },
  { p: 0.99, label: "p99" },
];

function PercentileTable({ rows, perf }: { rows: { series: Series; values: number[] }[]; perf: Perf }) {
  const thin = rows.some((r) => PERCENTILES.some(({ p }) => r.values.length < trustworthyAt(p)));
  return (
    <>
      <table className="lv-pf__table" data-cols={PERCENTILES.length}>
        <thead>
          <tr>
            <th scope="col">Model</th>
            {PERCENTILES.map((c) => (
              <th key={c.label} scope="col" className="num">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const errs = perf.errors.get(r.series.key) ?? 0;
            return (
              <tr key={r.series.key}>
                <th scope="row">
                  <ModelName series={r.series} />
                  <small>
                    {count(r.values.length)} {r.series.role === "primary" ? "requests" : "answers"}
                    {errs > 0 && `, ${count(errs)} ${errs === 1 ? "error" : "errors"} left out`}
                  </small>
                </th>
                {PERCENTILES.map(({ p, label }) => (
                  <td key={label} className="num" data-thin={r.values.length < trustworthyAt(p) || undefined}>
                    {ms(quantile(r.values, p))}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {thin && (
        <p className="lv-pf__foot small">
          Grey figures rest on fewer than ten requests beyond them, so one slow call moves them. p99 needs about 1,000 requests.
        </p>
      )}
    </>
  );
}

function PairedList({ perf }: { perf: Perf }) {
  const cands = perf.series.filter((s) => s.role === "candidate");
  const rows = cands.map((s) => ({ s, p: perf.paired.get(s.key) })).filter((r) => r.p && r.p.n > 0);
  if (rows.length === 0) return <p className="small muted">No request has both latencies yet.</p>;
  return (
    <ul className="lv-pf__paired">
      {rows.map(({ s, p }) => {
        const share = p!.faster / p!.n;
        const med = quantile(p!.diffs, 0.5)!;
        return (
          <li key={s.key}>
            <ModelName series={s} />
            <span className="lv-pf__share" aria-hidden="true">
              <span data-slot={Math.min(s.slot, 4)} style={{ width: `${share * 100}%` }} />
              <i />
            </span>
            <span className="lv-pf__paired-text small">
              <b className="num">{pct(share, 0)}</b> faster
              <span className="muted">
                {" "}
                · median <b className="num">{signedMs(med)}</b> · {count(p!.n)} pairs
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------- distributions in rows (tokens, cost) ----------

interface DistRow {
  series: Series;
  values: number[];
  note: string;
}

/**
 * One row per model on a shared axis: every value as a faint dot, the middle
 * half as a box, the 5th to 95th percentile as a whisker and the median as a
 * dark tick.
 */
function Rows({
  rows,
  log,
  tick,
  unitLabel,
  describe,
}: {
  rows: DistRow[];
  log: boolean;
  tick: (v: number) => string;
  unitLabel: string;
  describe: (r: DistRow) => string;
}) {
  const [ref, W] = useWidth();
  const PAD = { top: 4, right: 14, bottom: 34, left: 14 };
  const ROW = 50;
  const H = PAD.top + rows.length * ROW + PAD.bottom;
  const plotW = Math.max(10, W - PAD.left - PAD.right);
  const all = rows.flatMap((r) => r.values);
  const positives = all.filter((v) => v > 0);
  let lo = 0;
  let hi = niceCeil(Math.max(...rows.map((r) => quantile(r.values, 0.99) ?? 0), 1e-12) * 1.04);
  if (log && positives.length) {
    lo = 10 ** Math.floor(Math.log10(Math.min(...positives)));
    hi = 10 ** Math.ceil(Math.log10(Math.max(...positives)));
  }
  const beyond = log ? 0 : all.filter((v) => v > hi).length;
  const x = (v: number) => {
    const c = Math.min(Math.max(v, lo), hi);
    const f = log ? (Math.log10(c) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : (c - lo) / (hi - lo);
    return PAD.left + f * plotW;
  };
  const ticks = log ? logTicks(lo, hi) : niceTicks(lo, hi, W < 520 ? 3 : 5);
  const label = rows.map(describe).join(" ");

  return (
    <figure className="lv-pf__fig">
      <div className="lv-pf__plot" ref={ref} style={{ height: H }}>
        {W > 0 && (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
            {ticks.map((v) => (
              <g key={v}>
                <line className="lv-pf__grid" x1={x(v)} x2={x(v)} y1={PAD.top} y2={H - PAD.bottom} />
                <text className="lv-pf__axis" x={x(v)} y={H - PAD.bottom + 16} textAnchor={x(v) < PAD.left + 12 ? "start" : "middle"}>
                  {tick(v)}
                </text>
              </g>
            ))}
            <text className="lv-pf__axis-title" x={PAD.left + plotW} y={H - 3} textAnchor="end">
              {unitLabel}
              {log ? ", log scale" : ""}
              {beyond > 0 ? `, ${count(beyond)} beyond the edge` : ""}
            </text>
            {rows.map((r, i) => {
              const s = spread(r.values);
              if (!s) return null;
              const top = PAD.top + i * ROW;
              const mid = top + 20 + 13;
              const slot = Math.min(r.series.slot, 4);
              return (
                <g key={r.series.key} data-slot={slot}>
                  <text className="lv-pf__rowname" x={PAD.left} y={top + 13}>
                    {r.series.model}
                  </text>
                  <text className="lv-pf__rownote" x={PAD.left + plotW} y={top + 13} textAnchor="end">
                    {r.note}
                  </text>
                  {r.values.map((v, j) => (
                    <circle key={j} className="lv-pf__jit" cx={x(v)} cy={mid + (((j * 0.6180339887) % 1) - 0.5) * 18} r={2} />
                  ))}
                  <line className="lv-pf__whisker" x1={x(s.p5)} x2={x(s.p95)} y1={mid} y2={mid} />
                  <rect className="lv-pf__box" x={x(s.p25)} y={mid - 7} width={Math.max(2, x(s.p75) - x(s.p25))} height={14} rx={3} />
                  <line className="lv-pf__median" x1={x(s.p50)} x2={x(s.p50)} y1={mid - 10} y2={mid + 10} />
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <figcaption className="small muted">Dots are single requests. Box: middle half. Whisker: 5th to 95th percentile. Dark tick: median.</figcaption>
    </figure>
  );
}

function TokensSection({ perf }: { perf: Perf }) {
  const rows: DistRow[] = perf.series
    .map((s) => {
      const values = perf.outputTokens.get(s.key) ?? [];
      const sp = spread(values);
      return { series: s, values, note: sp ? `median ${tokens(sp.p50)}` : "" };
    })
    .filter((r) => r.values.length > 0);
  const positives = rows.flatMap((r) => r.values.filter((v) => v > 0));
  const log = positives.length > 0 && Math.max(...positives) / Math.max(1, quantile(positives.slice().sort((a, b) => a - b), 0.05)!) > 60;
  const cands = perf.series.filter((s) => s.role === "candidate");

  return (
    <section className="lv-pf__sec" aria-labelledby="pf-tok-h">
      <div className="lv-pf__head">
        <h2 className="lv-pf__h2" id="pf-tok-h">
          Tokens and verbosity
        </h2>
        <p className="muted small">
          Output tokens drive both cost and time. A candidate that writes twice as much can lose its price advantage, and a judge can
          reward or punish length on its own, so check the ratio before reading the agreement rate.
        </p>
      </div>
      <div className="lv-pf__sheet lv-pf__sheet--split">
        <Cell title="Output tokens per answer" className="lv-pf__cell--chart">
          <Rows
            rows={rows}
            log={log}
            tick={(v) => tokens(v)}
            unitLabel="output tokens"
            describe={(r) => {
              const s = spread(r.values)!;
              return `${r.series.model}: median ${tokens(s.p50)} output tokens, middle half ${tokens(s.p25)} to ${tokens(s.p75)}.`;
            }}
          />
        </Cell>
        <Cell title="Candidate against primary" note="Same request, candidate output tokens divided by the primary's.">
          <table className="lv-pf__table" data-cols={3}>
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col" className="num">
                  Median
                </th>
                <th scope="col" className="num">
                  Middle half
                </th>
                <th scope="col" className="num">
                  Overall
                </th>
              </tr>
            </thead>
            <tbody>
              {cands.map((s) => {
                const r = perf.tokenRatio.get(s.key) ?? [];
                const t = perf.tokenTotals.get(s.key);
                return (
                  <tr key={s.key}>
                    <th scope="row">
                      <ModelName series={s} />
                      <small>{count(r.length)} answers</small>
                    </th>
                    <td className="num">{ratio(quantile(r, 0.5))}</td>
                    <td className="num">
                      {r.length ? `${ratio(quantile(r, 0.25))}–${ratio(quantile(r, 0.75))}` : "–"}
                    </td>
                    <td className="num">{t && t.primary > 0 ? ratio(t.candidate / t.primary) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="lv-pf__foot small">
            Overall divides total output tokens, so long answers weigh more. Under 1× is terser than the primary. Input tokens are the same
            prompt counted by each model&rsquo;s tokenizer.
          </p>
        </Cell>
      </div>
    </section>
  );
}

// ---------- cost ----------

function CostSection({ perf }: { perf: Perf }) {
  const rows: DistRow[] = perf.series
    .map((s) => {
      const values = perf.cost.get(s.key) ?? [];
      const sp = spread(values);
      return { series: s, values, note: sp ? `mean ${usd(sp.mean)}` : "" };
    })
    .filter((r) => r.values.length > 0);
  const positives = rows.flatMap((r) => r.values.filter((v) => v > 0));
  const log = positives.length > 0 && Math.max(...positives) / Math.min(...positives) > 20;
  const primaryMean = spread(rows.find((r) => r.series.role === "primary")?.values ?? [])?.mean;

  return (
    <section className="lv-pf__sec" aria-labelledby="pf-cost-h">
      <div className="lv-pf__head">
        <h2 className="lv-pf__h2" id="pf-cost-h">
          Cost
        </h2>
        <p className="muted small">
          What each model charged per request at the gateway&rsquo;s configured prices, input and output together. Candidate errors are
          left out; they are recorded at no cost.
        </p>
      </div>
      <div className="lv-pf__sheet lv-pf__sheet--split">
        <Cell title="Cost per request" className="lv-pf__cell--chart">
          <Rows
            rows={rows}
            log={log}
            tick={tickUsd}
            unitLabel="US dollars per request"
            describe={(r) => {
              const s = spread(r.values)!;
              return `${r.series.model}: mean ${usd(s.mean)} per request, median ${usd(s.p50)}.`;
            }}
          />
        </Cell>
        <Cell title="Averages">
          <table className="lv-pf__table" data-cols={3}>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col" className="num">
                  Mean
                </th>
                <th scope="col" className="num">
                  Per 1,000
                </th>
                <th scope="col" className="num">
                  Against primary
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const m = spread(r.values)!.mean;
                return (
                  <tr key={r.series.key}>
                    <th scope="row">
                      <ModelName series={r.series} />
                      <small>
                        {count(r.values.length)} {r.series.role === "primary" ? "requests" : "answers"}
                      </small>
                    </th>
                    <td className="num">{usd(m)}</td>
                    <td className="num">{usd(m * 1000)}</td>
                    <td className="num">
                      {r.series.role === "primary" || !primaryMean ? "–" : `${minus(m - primaryMean)}${pct(Math.abs(m / primaryMean - 1), 0)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="lv-pf__foot small">
            The primary counts once per request; each candidate once per answer it gave. Means, not medians, set the bill, so they drive
            the payback below.
          </p>
        </Cell>
      </div>
    </section>
  );
}

// ---------- payback ----------

function PaybackSection({
  perf,
  rate,
  paybacks,
  best,
  summary,
  partial,
  total,
}: {
  perf: Perf;
  rate?: Rate;
  paybacks: Payback[];
  best?: { payback: Payback; ready: boolean };
  summary?: Summary;
  partial: boolean;
  total: number;
}) {
  const spent = perf.spend.candidate + perf.spend.judge;
  const perRequest = perf.requests > 0 ? spent / perf.requests : 0;
  const bestSeries = best && perf.series.find((s) => s.key === best.payback.key);
  const budget = summary?.daily_budget_usd ?? 0;
  // Keeping the shadow running: what today's sampling costs a day, capped by the budget.
  const shadowPerDay = rate ? Math.min(budget > 0 ? budget : Infinity, rate.sampledPerDay * perRequest) : undefined;
  const save = best?.payback.savingPerDay;
  const sampled = rate ? 1 / rate.scale : 1;
  // The share of requests the shadow can sample and still cost less a day than the switch saves.
  const evenShare = best && perRequest > 0 ? best.payback.savingPerRequest / perRequest : undefined;
  const scorecard = summary?.pairs.find((p) => candidateKey(p) === best?.payback.key);

  return (
    <section className="lv-pf__sec" aria-labelledby="pf-pay-h">
      <div className="lv-pf__head">
        <h2 className="lv-pf__h2" id="pf-pay-h">
          Does shadowing pay for itself?
        </h2>
        <p className="muted small">
          What these comparisons cost to run, candidate calls and judging, against what the best ready candidate would save a day at this
          gateway&rsquo;s pace. Break-even is how long switched traffic takes to repay the evidence.
        </p>
      </div>
      <div className="lv-pf__sheet lv-pf__sheet--even">
        <Cell title="The ledger">
          <dl className="lv-pf__ledger">
            <div>
              <dt>Spent on shadowing</dt>
              <dd>
                <b className="num">{usd(spent)}</b>
                <span className="small muted">
                  {" "}
                  for {count(perf.comparisons)} comparisons: candidate calls {usd(perf.spend.candidate)}, judging {usd(perf.spend.judge)}.
                  That is {usd(perRequest)} per sampled request.
                </span>
              </dd>
            </div>
            {summary && (
              <div>
                <dt>Today</dt>
                <dd>
                  <b className="num">{usd(summary.spend_today_usd)}</b>
                  <span className="small muted">
                    {budget > 0 ? (
                      <>
                        {" "}
                        of the {usd(budget)} daily budget
                        {summary.budget_exhausted ? ", used up: sampling pauses until the UTC day turns" : ""}.
                      </>
                    ) : (
                      " with no daily budget set."
                    )}
                  </span>
                  {budget > 0 && (
                    <span className="lv-pf__meter" role="img" aria-label={`${pct(summary.spend_today_usd / budget, 0)} of the daily budget used`}>
                      <span style={{ width: `${Math.min(100, (summary.spend_today_usd / budget) * 100)}%` }} />
                    </span>
                  )}
                </dd>
              </div>
            )}
            <div>
              <dt>Traffic</dt>
              <dd>
                {rate ? (
                  <>
                    <b className="num">{count(Math.round(rate.perDay))} requests a day</b>
                    <span className="small muted">
                      {" "}
                      from {count(rate.requests)} sampled requests over {span(rate.spanMs)}
                      {rate.quietMs > 0 ? `, ${span(rate.quietMs)} of it quiet` : ""}
                      {rate.scale !== 1 ? `, scaled by ${ratio(rate.scale)} for the requests not sampled` : ""}.
                      {rate.activePerDay !== undefined && <> Busy stretches alone ran at {count(Math.round(rate.activePerDay))} a day.</>}
                    </span>
                  </>
                ) : (
                  <span className="small muted">Needs at least two requests.</span>
                )}
              </dd>
            </div>
            <div data-emphasis>
              <dt>If it switched</dt>
              <dd>
                {best && bestSeries ? (
                  <>
                    <b className="num">{perDayUsd(save)}</b>
                    <span className="small muted">
                      {" "}
                      saved by <span className="model">{bestSeries.model}</span>
                      {best.ready ? "" : " (not ready: a what-if)"}, {usd(best.payback.savingPerRequest)} a request
                      {save !== undefined ? `, about ${usd(save * 30)} a month` : ""}.
                    </span>
                  </>
                ) : (
                  <span className="small muted">No candidate costs less than the primary on this traffic.</span>
                )}
              </dd>
            </div>
            <div data-emphasis>
              <dt>Break-even</dt>
              <dd>
                {best?.payback.breakEvenDays !== undefined ? (
                  <>
                    <b className="num">{humanDays(best.payback.breakEvenDays)}</b>
                    <span className="small muted">
                      {" "}
                      of switched traffic repays {usd(spent)}
                      {rate?.activePerDay !== undefined && save
                        ? `; ${humanDays(spent / ((save * rate.activePerDay) / rate.perDay))} at the busy-stretch pace`
                        : ""}
                      .
                    </span>
                  </>
                ) : (
                  <span className="small muted">Not reached: nothing saves money yet.</span>
                )}
              </dd>
            </div>
            {shadowPerDay !== undefined && save !== undefined && save > 0 && (
              <div>
                <dt>Keep shadowing</dt>
                <dd>
                  <b className="num">{perDayUsd(shadowPerDay)}</b>
                  <span className="small muted">
                    {" "}
                    at today&rsquo;s sampling ({pct(sampled, 0)} of requests)
                    {budget > 0 && rate && rate.sampledPerDay * perRequest > budget ? ", held to the daily budget" : ""}.{" "}
                    {shadowPerDay > save ? (
                      <>
                        That is {ratio(shadowPerDay / save)} the saving, so after switching, sample{" "}
                        {evenShare !== undefined ? `under ${pct(Math.min(1, evenShare), evenShare < 0.1 ? 1 : 0)} of requests` : "less"} to
                        keep watching for less than the switch saves.
                      </>
                    ) : (
                      <>Less than the saving, so watching can carry on after the switch.</>
                    )}
                  </span>
                </dd>
              </div>
            )}
          </dl>
        </Cell>
        <Cell title="Saving after a switch" note="Cumulative saving from the moment the candidate takes over, against what the evidence cost.">
          {best?.payback.breakEvenDays !== undefined ? (
            <PaybackChart perf={perf} paybacks={paybacks} best={best} spent={spent} shadowPerDay={shadowPerDay} />
          ) : (
            <p className="small muted lv-pf__fig">Appears once a candidate saves money at a measurable request rate.</p>
          )}
          <details className="lv-pf__assume small">
            <summary>Assumptions</summary>
            <ul>
              <li>
                Traffic keeps the pace the loaded requests arrived at, from the first to the last one recorded, quiet gaps included.
                {rate?.scaleFrom === "counters" &&
                  ` The gateway counted ${count(summary?.counters.eligible)} eligible requests and sampled ${count(summary?.counters.sampled)}, so the pace is scaled by ${ratio(rate.scale)}.`}
                {rate?.scaleFrom === "sample_rate" && ` The pace is scaled by 1 ÷ the ${pct(summary?.sample_rate, 0)} sample rate.`}
              </li>
              <li>
                The saving per request is the mean of primary cost minus candidate cost over the candidate&rsquo;s completed comparisons, at
                the gateway&rsquo;s configured prices. It assumes future requests look like these and the candidate keeps its answer length.
              </li>
              <li>
                Spending counts candidate calls plus judge and embedding calls in the loaded comparisons
                {partial ? `; the gateway holds ${count(total)}, and the older ones are not counted here` : ""}. A switch is assumed to stop
                the shadow unless the dotted line says otherwise.
              </li>
              <li>Failed answers, canary traffic, retries and price changes are not priced in.</li>
              {scorecard && scorecard.projected_monthly_savings_usd !== 0 && (
                <li>
                  Cross-check: the scorecard projects {usd(scorecard.projected_monthly_savings_usd)} a month for{" "}
                  <span className="model">{scorecard.candidate.model}</span>, from the gateway&rsquo;s own count of eligible requests
                  since it started.
                </li>
              )}
            </ul>
          </details>
        </Cell>
      </div>
    </section>
  );
}

const HORIZONS = [1 / 24, 2 / 24, 3 / 24, 6 / 24, 12 / 24, 1, 2, 3, 7, 14, 30, 60, 90, 180, 365];

/** Cumulative saving after a switch against what the evidence cost, for each candidate that saves money. */
function PaybackChart({
  perf,
  paybacks,
  best,
  spent,
  shadowPerDay,
}: {
  perf: Perf;
  paybacks: Payback[];
  best: { payback: Payback; ready: boolean };
  spent: number;
  shadowPerDay?: number;
}) {
  const [ref, W] = useWidth();
  const lines = paybacks.filter((p) => p.savingPerDay !== undefined && p.savingPerDay > 0);
  if (lines.length === 0 || best.payback.breakEvenDays === undefined) return null;
  const H = 190;
  const PAD = { top: 14, right: 16, bottom: 34, left: 52 };
  const plotW = Math.max(10, W - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const days = HORIZONS.find((d) => d >= best.payback.breakEvenDays! * 1.8) ?? 365;
  const yMax = niceCeil(Math.max(spent * 1.5, best.payback.savingPerDay! * days));
  const x = (d: number) => PAD.left + (d / days) * plotW;
  const y = (v: number) => PAD.top + (1 - Math.min(v, yMax) / yMax) * plotH;
  const tickDays = niceTicks(0, days < 1 ? days * 24 : days, 4).map((v) => (days < 1 ? v / 24 : v));
  const be = best.payback.breakEvenDays;
  const keepSlope = shadowPerDay ?? 0;
  const seriesOf = (key: string) => perf.series.find((s) => s.key === key)!;

  return (
    <figure className="lv-pf__fig lv-pf__payback">
      <div className="lv-pf__plot" ref={ref} style={{ height: H }}>
        {W > 0 && (
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Cumulative saving after switching against ${usd(spent)} spent on shadowing. ${seriesOf(best.payback.key).model} repays it in ${humanDays(be)}.`}
          >
            {niceTicks(0, yMax, 3).map((v) => (
              <g key={v}>
                <line className="lv-pf__grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
                <text className="lv-pf__axis" x={PAD.left - 8} y={y(v) + 4} textAnchor="end">
                  {tickUsd(v)}
                </text>
              </g>
            ))}
            {tickDays.map((d) => (
              <text key={d} className="lv-pf__axis" x={x(d)} y={H - 16} textAnchor={d === 0 ? "start" : "middle"}>
                {d === 0 ? "switch" : days < 1 ? `${+(d * 24).toFixed(1)} h` : `${+d.toFixed(1)} d`}
              </text>
            ))}
            <text className="lv-pf__axis-title" x={PAD.left + plotW} y={H - 2} textAnchor="end">
              time after switching
            </text>
            {/* What the evidence cost, and what it keeps costing if the shadow stays on. */}
            <line className="lv-pf__spent" x1={PAD.left} x2={PAD.left + plotW} y1={y(spent)} y2={y(spent)} />
            {keepSlope > 0 && <line className="lv-pf__keep" x1={x(0)} y1={y(spent)} x2={x(days)} y2={y(spent + keepSlope * days)} />}
            {/* At the right end the lines have climbed away from the spent line, so its label stays clear. */}
            <text className="lv-pf__label" x={PAD.left + plotW} y={y(spent) - 7} textAnchor="end">
              spent so far {usd(spent)}
            </text>
            {lines.map((p) => {
              const s = seriesOf(p.key);
              const end = Math.min(days, yMax / p.savingPerDay!);
              return (
                <g
                  key={p.key}
                  data-slot={Math.min(s.slot, 4)}
                  data-best={p.key === best.payback.key || undefined}
                  data-ready={p.verdict === "ready" || undefined}
                >
                  <path className="lv-pf__halo" d={`M${x(0)},${y(0)}L${x(end)},${y(p.savingPerDay! * end)}`} />
                  <path className="lv-pf__line" d={`M${x(0)},${y(0)}L${x(end)},${y(p.savingPerDay! * end)}`} />
                </g>
              );
            })}
            <g className="lv-pf__even">
              <circle cx={x(be)} cy={y(spent)} r={5} />
              <text x={x(be) + (x(be) > PAD.left + plotW * 0.6 ? -10 : 10)} y={y(spent) + 18} textAnchor={x(be) > PAD.left + plotW * 0.6 ? "end" : "start"}>
                even after {humanDays(be).replace(/^about /, "")}
              </text>
            </g>
          </svg>
        )}
      </div>
      <figcaption>
        <ul className="lv-pf__key small">
          {lines.map((p) => (
            <li key={p.key}>
              <Swatch slot={seriesOf(p.key).slot} />
              <span className="model">{seriesOf(p.key).model}</span>
              <span className="lv-pf__role">
                saving {perDayUsd(p.savingPerDay)}
                {p.verdict === "ready" ? "" : `, ${p.verdict ? VERDICT_LABEL[p.verdict].toLowerCase() : "no verdict"}`}
              </span>
            </li>
          ))}
          <li>
            <i className="lv-pf__sw" data-kind="spent" aria-hidden="true" />
            spent so far
          </li>
          {keepSlope > 0 && (
            <li>
              <i className="lv-pf__sw" data-kind="keep" aria-hidden="true" />
              if the shadow stays on
            </li>
          )}
        </ul>
      </figcaption>
    </figure>
  );
}

// ---------- quality against cost ----------

interface Point {
  series: Series;
  cost: number;
  lower: number;
  agreement: number;
  n: number;
  verdict?: Verdict;
}

function FrontierSection({ perf, summary }: { perf: Perf; summary?: Summary }) {
  const minAgreement = summary?.thresholds.min_agreement ?? 0.9;
  const primary = perf.series.find((s) => s.role === "primary");
  const primaryCost = spread(perf.cost.get(primary?.key ?? "") ?? [])?.mean;
  const points: Point[] = perf.series
    .filter((s) => s.role === "candidate")
    .map((s): Point | undefined => {
      const c = perf.candidates.get(s.key)!;
      return c.avgCandidateCost !== undefined && c.lower !== undefined && c.agreement !== undefined
        ? { series: s, cost: c.avgCandidateCost, lower: c.lower, agreement: c.agreement, n: c.evidence, verdict: c.verdict }
        : undefined;
    })
    .filter((p): p is Point => p !== undefined);

  return (
    <section className="lv-pf__sec" aria-labelledby="pf-front-h">
      <div className="lv-pf__head">
        <h2 className="lv-pf__h2" id="pf-front-h">
          Quality against cost
        </h2>
        <p className="muted small">
          Each candidate sits at its average cost per request and the 95% lower bound of its agreement with the primary; the thin line
          above the dot reaches the observed rate. The primary agrees with itself by definition. Worth switching to: the shaded corner,
          cheaper than the primary and at or above the {pct(minAgreement, 0)} bar.
        </p>
      </div>
      <div className="lv-pf__sheet lv-pf__sheet--split">
        <Cell title="Agreement lower bound by cost per request" className="lv-pf__cell--chart">
          {primary && primaryCost !== undefined && points.length > 0 ? (
            <Frontier primary={primary} primaryCost={primaryCost} points={points} minAgreement={minAgreement} />
          ) : (
            <p className="small muted">Appears once a candidate has scored comparisons.</p>
          )}
        </Cell>
        <Cell title="Readings">
          <table className="lv-pf__table" data-cols={2}>
            <thead>
              <tr>
                <th scope="col">Candidate</th>
                <th scope="col" className="num">
                  Lower bound
                </th>
                <th scope="col" className="num">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.series.key}>
                  <th scope="row">
                    <ModelName series={p.series} />
                    <small>
                      {p.verdict ? `${VERDICT_LABEL[p.verdict]}, ` : ""}
                      {pct(p.agreement, 1)} of {count(p.n)}
                    </small>
                  </th>
                  <td className="num" data-short={p.lower < minAgreement || undefined}>
                    {pct(p.lower, 1)}
                  </td>
                  <td className="num">{primaryCost ? `${pct(p.cost / primaryCost, p.cost / primaryCost < 0.1 ? 1 : 0)}` : usd(p.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="lv-pf__foot small">Cost as a share of the primary&rsquo;s, over the same loaded comparisons. Verdicts come from the scorecards.</p>
        </Cell>
      </div>
    </section>
  );
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Two-line labels next to points: each tries right, left, below and above its
 * point, and takes the first spot that stays in bounds and clears the labels
 * already placed and every point.
 */
function placeLabels(items: { key: string; name: string; sub: string; cx: number; cy: number; above?: boolean }[], bounds: Box) {
  const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  // Labels side by side read as one line, so they keep a wide berth from each other.
  const roomy = (b: Box): Box => ({ left: b.left - 16, right: b.right + 16, top: b.top - 2, bottom: b.bottom + 2 });
  const dots: Box[] = items.map((p) => ({ left: p.cx - 8, right: p.cx + 8, top: p.cy - 8, bottom: p.cy + 8 }));
  const taken: Box[] = [];
  return items.map((p) => {
    // Mono name at 12px and sub at 11.5px, measured roughly.
    const w = Math.max(p.name.length * 7.3, p.sub.length * 6.1) + 4;
    const beside = [
      { anchor: "start" as const, x: p.cx + 12, y: p.cy - 1 },
      { anchor: "end" as const, x: p.cx - 12, y: p.cy - 1 },
    ];
    const below = [
      { anchor: "start" as const, x: p.cx + 6, y: p.cy + 22 },
      { anchor: "end" as const, x: p.cx - 6, y: p.cy + 22 },
    ];
    const over = [
      { anchor: "start" as const, x: p.cx + 6, y: p.cy - 20 },
      { anchor: "end" as const, x: p.cx - 6, y: p.cy - 20 },
    ];
    const spots = p.above ? [...over, ...beside, ...below] : [...beside, ...below, ...over];
    const boxOf = (s: (typeof spots)[number]): Box => ({
      left: s.anchor === "start" ? s.x : s.x - w,
      right: s.anchor === "start" ? s.x + w : s.x,
      top: s.y - 12,
      bottom: s.y + 17,
    });
    // Leaving the plot is worst, covering another label next, covering a point least bad.
    const cost = (b: Box) =>
      (b.left < bounds.left || b.right > bounds.right || b.top < bounds.top || b.bottom > bounds.bottom + 14 ? 100 : 0) +
      taken.filter((t) => overlaps(roomy(t), b)).length * 10 +
      dots.filter((d) => overlaps(d, b)).length;
    const spot = spots.reduce((best, s) => (cost(boxOf(s)) < cost(boxOf(best)) ? s : best));
    taken.push(boxOf(spot));
    return { key: p.key, name: p.name, sub: p.sub, ...spot };
  });
}

function Frontier({ primary, primaryCost, points, minAgreement }: { primary: Series; primaryCost: number; points: Point[]; minAgreement: number }) {
  const [ref, W] = useWidth();
  const H = W < 520 ? 260 : 300;
  // Room above the 100% line for the primary's label.
  const PAD = { top: 38, right: 18, bottom: 40, left: 46 };
  const plotW = Math.max(10, W - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const costs = [primaryCost, ...points.map((p) => p.cost)].filter((c) => c > 0);
  const log = costs.length > 1 && Math.max(...costs) / Math.min(...costs) > 4;
  const lo = log ? 10 ** Math.floor(Math.log10(Math.min(...costs) / 1.5)) : 0;
  const hi = log ? 10 ** Math.ceil(Math.log10(Math.max(...costs) * 1.5)) : niceCeil(Math.max(...costs) * 1.2);
  const x = (v: number) => {
    const c = Math.min(Math.max(v, lo || 0), hi);
    const f = log ? (Math.log10(Math.max(c, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) : c / hi;
    return PAD.left + f * plotW;
  };
  const lowest = Math.min(minAgreement, ...points.map((p) => p.lower));
  const yMin = lowest >= 0.5 ? 0.5 : Math.max(0, Math.floor((lowest - 0.05) * 10) / 10);
  const y = (f: number) => PAD.top + (1 - (Math.max(f, yMin) - yMin) / (1 - yMin)) * plotH;
  const yTicks = niceTicks(yMin, 1, 4);

  // The frontier: from the cheapest point, every point that agrees more than all cheaper ones.
  const all = [{ cost: primaryCost, lower: 1, key: primary.key }, ...points.map((p) => ({ cost: p.cost, lower: p.lower, key: p.series.key }))].sort(
    (a, b) => a.cost - b.cost,
  );
  const frontier: typeof all = [];
  for (const p of all) if (!frontier.length || p.lower > frontier[frontier.length - 1].lower) frontier.push(p);

  const label = `Agreement lower bound against cost per request. ${primary.model}, the primary: ${usd(primaryCost)}, 100%. ${points
    .map((p) => `${p.series.model}: ${usd(p.cost)}, lower bound ${pct(p.lower, 1)}${p.lower >= minAgreement ? ", above the bar" : ", below the bar"}`)
    .join(". ")}.`;

  return (
    <figure className="lv-pf__fig">
      <div className="lv-pf__plot" ref={ref} style={{ height: H }}>
        {W > 0 && (
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
            <rect className="lv-pf__zone" x={PAD.left} y={y(1)} width={Math.max(0, x(primaryCost) - PAD.left)} height={Math.max(0, y(minAgreement) - y(1))} />
            {yTicks.map((f) => (
              <g key={f}>
                <line className="lv-pf__grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(f)} y2={y(f)} />
                <text className="lv-pf__axis" x={PAD.left - 8} y={y(f) + 4} textAnchor="end">
                  {Math.round(f * 100)}%
                </text>
              </g>
            ))}
            {(log ? logTicks(lo, hi) : niceTicks(0, hi, 4)).map((v) => (
              <text key={v} className="lv-pf__axis" x={x(v)} y={PAD.top + plotH + 18} textAnchor={x(v) < PAD.left + 14 ? "start" : "middle"}>
                {tickUsd(v)}
              </text>
            ))}
            <text className="lv-pf__axis-title" x={PAD.left + plotW} y={H - 4} textAnchor="end">
              average cost per request{log ? ", log scale" : ""}
            </text>
            <line className="lv-pf__need" x1={PAD.left} x2={PAD.left + plotW} y1={y(minAgreement)} y2={y(minAgreement)} />
            <text className="lv-pf__label" x={PAD.left + plotW} y={y(minAgreement) + 15} textAnchor="end">
              needs {pct(minAgreement, 0)}
            </text>
            <path
              className="lv-pf__frontier"
              d={frontier.map((p, i) => `${i ? "L" : "M"}${x(p.cost).toFixed(1)},${y(p.lower).toFixed(1)}`).join("")}
            />
            {points.map((p) => (
              <g key={p.series.key} data-slot={Math.min(p.series.slot, 4)}>
                <title>{`${p.series.model}: ${usd(p.cost)} per request, agreement ${pct(p.agreement, 1)}, lower bound ${pct(p.lower, 1)} over ${count(p.n)}`}</title>
                <line className="lv-pf__range" x1={x(p.cost)} x2={x(p.cost)} y1={y(p.lower)} y2={y(p.agreement)} />
                <line className="lv-pf__range" x1={x(p.cost) - 4} x2={x(p.cost) + 4} y1={y(p.agreement)} y2={y(p.agreement)} />
                <circle className="lv-pf__dot" cx={x(p.cost)} cy={y(p.lower)} r={6} />
              </g>
            ))}
            <g data-slot={0}>
              <title>{`${primary.model}, the primary: ${usd(primaryCost)} per request`}</title>
              <rect className="lv-pf__dot" x={x(primaryCost) - 5.5} y={y(1) - 5.5} width={11} height={11} transform={`rotate(45 ${x(primaryCost)} ${y(1)})`} />
            </g>
            {placeLabels(
              [
                { key: primary.key, name: primary.model, sub: `primary, ${usd(primaryCost)}`, cx: x(primaryCost), cy: y(1), above: true },
                ...points.map((p) => ({ key: p.series.key, name: p.series.model, sub: `${pct(p.lower, 1)}, ${usd(p.cost)}`, cx: x(p.cost), cy: y(p.lower) })),
              ],
              { left: PAD.left - 6, right: W - 2, top: 0, bottom: PAD.top + plotH - 2 },
            ).map((l) => (
              <g key={l.key} className="lv-pf__plabel">
                <text x={l.x} y={l.y} textAnchor={l.anchor}>
                  {l.name}
                </text>
                <text className="lv-pf__plabel-sub" x={l.x} y={l.y + 13} textAnchor={l.anchor}>
                  {l.sub}
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>
      <figcaption className="small muted">
        Dot: 95% lower bound. Tick above it: observed agreement. Diamond: the primary. The grey line joins the models nothing cheaper beats.
      </figcaption>
    </figure>
  );
}

// ---------- traffic ----------

const OUTCOMES: { id: keyof Omit<Bucket, "kind" | "start">; label: string }[] = [
  { id: "pass", label: "agreed" },
  { id: "fail", label: "disagreed" },
  { id: "error", label: "candidate error" },
  { id: "unscored", label: "unscored" },
];

function TrafficSection({ records, perf }: { records: ShadowRecord[]; perf: Perf }) {
  const errors = [...perf.errors.values()].reduce((a, b) => a + b, 0);
  return (
    <section className="lv-pf__sec" aria-labelledby="pf-traffic-h">
      <div className="lv-pf__head">
        <h2 className="lv-pf__h2" id="pf-traffic-h">
          Traffic over time
        </h2>
        <p className="muted small">
          Comparisons as they were recorded, stacked by outcome. A burst of errors is a candidate or provider outage; a wall of
          disagreements in one stretch points at one kind of request. Long quiet stretches are folded so the busy ones stay readable.
          {errors > 0 && ` ${count(errors)} candidate ${errors === 1 ? "error" : "errors"} in the loaded comparisons.`}
        </p>
      </div>
      <div className="lv-pf__sheet">
        <div className="lv-pf__cell lv-pf__cell--chart">
          <TrafficChart records={records} />
        </div>
      </div>
    </section>
  );
}

function TrafficChart({ records }: { records: ShadowRecord[] }) {
  const [ref, W] = useWidth();
  const H = W < 520 ? 200 : 230;
  const PAD = { top: 12, right: 14, bottom: 40, left: 38 };
  const plotW = Math.max(10, W - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const t = useMemo(() => (W > 0 ? traffic(records, Math.max(12, Math.floor(plotW / 14))) : undefined), [records, W, plotW]);
  if (!t) return <div className="lv-pf__plot" ref={ref} style={{ height: H }} />;

  const units = t.slots.reduce((n, s) => n + (s.kind === "quiet" ? QUIET_WIDTH : 1), 0);
  const unit = plotW / units;
  const barW = Math.max(1, Math.min(24, unit * 0.72));
  const totalOf = (b: Bucket) => b.pass + b.fail + b.error + b.unscored;
  const buckets = t.slots.filter((s): s is Bucket => s.kind === "bucket");
  const max = Math.max(1, ...buckets.map(totalOf));
  const yTicks = niceTicks(0, niceCeil(max), 3).filter((v) => Number.isInteger(v));
  const yMax = Math.max(max, yTicks[yTicks.length - 1] ?? max);
  const y = (v: number) => PAD.top + (1 - v / yMax) * plotH;
  const sameDay = new Date(buckets[0].start).toDateString() === new Date(buckets[buckets.length - 1].start).toDateString();
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: t.step < 60_000 ? "2-digit" : undefined });
  const day = (at: number) => new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
  const labelEvery = Math.max(1, Math.ceil((W < 520 ? 76 : 88) / unit));
  const busiest = buckets.reduce((a, b) => (totalOf(b) > totalOf(a) ? b : a), buckets[0]);
  const errorBuckets = buckets.filter((b) => b.error > 0).length;
  const quiet = t.slots.filter((s) => s.kind === "quiet").length;
  const label = `Comparisons per ${stepWords(t.step)} from ${time(buckets[0].start)} to ${time(buckets[buckets.length - 1].start)}. Busiest ${stepWords(t.step)}: ${count(totalOf(busiest))} at ${time(busiest.start)}.${errorBuckets ? ` Candidate errors in ${count(errorBuckets)} of them.` : " No candidate errors."}${quiet ? ` ${count(quiet)} quiet ${quiet === 1 ? "stretch" : "stretches"} folded.` : ""}`;

  let cursor = 0;
  let lastLabelAt = -Infinity;
  let lastDay = "";
  return (
    <figure className="lv-pf__fig">
      <div className="lv-pf__plot" ref={ref} style={{ height: H }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
          {yTicks.map((v) => (
            <g key={v}>
              <line className="lv-pf__grid" data-strong={v === 0 || undefined} x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
              <text className="lv-pf__axis" x={PAD.left - 8} y={y(v) + 4} textAnchor="end">
                {v}
              </text>
            </g>
          ))}
          {t.slots.map((s, i) => {
            const at = cursor;
            cursor += s.kind === "quiet" ? QUIET_WIDTH : 1;
            const left = PAD.left + at * unit;
            if (s.kind === "quiet") {
              const w = QUIET_WIDTH * unit;
              const cx = left + w / 2;
              return (
                <g key={`q${i}`} className="lv-pf__quiet">
                  <title>{`No comparisons for ${span(s.to - s.from)}`}</title>
                  <rect x={left + 2} y={PAD.top} width={Math.max(0, w - 4)} height={plotH} />
                  <path d={`M${cx - 5},${y(0) + 5}l4,-10M${cx + 1},${y(0) + 5}l4,-10`} />
                  {w >= 46 && (
                    <text x={cx} y={PAD.top + 14} textAnchor="middle">
                      {span(s.to - s.from).replace(/ \d+ (s|min)$/, "")}
                    </text>
                  )}
                  {w >= 46 && (
                    <text x={cx} y={PAD.top + 27} textAnchor="middle">
                      quiet
                    </text>
                  )}
                </g>
              );
            }
            const total = totalOf(s);
            const cx = left + unit / 2;
            let base = 0;
            const gap = barW >= 4 ? 1.5 : 0;
            // A time label on the first bucket after a fold, then every few buckets.
            const afterQuiet = i === 0 || t.slots[i - 1].kind === "quiet";
            const showLabel = afterQuiet ? at - lastLabelAt >= labelEvery * 0.6 : at - lastLabelAt >= labelEvery;
            const d = day(s.start);
            const text = showLabel ? (!sameDay && d !== lastDay ? `${d} ${time(s.start)}` : time(s.start)) : "";
            if (showLabel) {
              lastLabelAt = at;
              lastDay = d;
            }
            return (
              <g key={s.start}>
                <title>
                  {`${time(s.start)}: ${count(total)} ${total === 1 ? "comparison" : "comparisons"}${OUTCOMES.filter((o) => s[o.id] > 0)
                    .map((o) => `, ${count(s[o.id])} ${o.label}`)
                    .join("")}`}
                </title>
                <rect className="lv-pf__hit" x={left} y={PAD.top} width={unit} height={plotH} />
                {OUTCOMES.map((o) => {
                  const v = s[o.id];
                  if (v === 0) return null;
                  const y0 = y(base);
                  const y1 = y(base + v);
                  base += v;
                  // A sliver of surface between stacked segments keeps them apart.
                  const h = Math.max(1, y0 - y1 - (base - v > 0 ? gap : 0));
                  return <rect key={o.id} className="lv-pf__bar" data-outcome={o.id} x={cx - barW / 2} y={y1} width={barW} height={h} rx={base === total && barW >= 6 ? 2 : 0} />;
                })}
                {text && (
                  <>
                    <line className="lv-pf__tick" x1={cx} x2={cx} y1={y(0)} y2={y(0) + 4} />
                    <text className="lv-pf__axis" x={cx} y={y(0) + 17} textAnchor={at === 0 ? "start" : "middle"}>
                      {text}
                    </text>
                  </>
                )}
              </g>
            );
          })}
          <text className="lv-pf__axis-title" x={PAD.left + plotW} y={H - 3} textAnchor="end">
            comparisons per {stepWords(t.step)}
          </text>
        </svg>
      </div>
      <figcaption>
        <ul className="lv-pf__key small">
          {OUTCOMES.map((o) => (
            <li key={o.id}>
              <i className="lv-pf__sw" data-kind="bar" data-outcome={o.id} aria-hidden="true" />
              {o.label}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}
