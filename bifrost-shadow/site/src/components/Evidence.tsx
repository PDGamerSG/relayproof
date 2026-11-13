import { useMemo, useState, type CSSProperties } from "react";
import { DEFAULT_THRESHOLDS, pct, read, VERDICT_LABEL, wilsonLowerBound, type Reading } from "../lib/stats";
import "./Evidence.css";

const N_MIN = 5;
const N_MAX = 400;
const Y_MIN = 0.4;
const NEED = DEFAULT_THRESHOLDS.minAgreement;

const PRESETS = [
  { n: 20, d: 0, label: "20 of 20" },
  { n: 35, d: 0, label: "35 of 35" },
  { n: 162, d: 1, label: "161 of 162", note: "gpt-4o-mini in the demo" },
  { n: 162, d: 60, label: "102 of 162", note: "llama-3.1-8b in the demo" },
];

const X_TICKS = [5, 10, 20, 50, 100, 200, 400];
const Y_TICKS = [0.4, 0.6, 0.8, 1];

/** Evidence on a log scale: the first few dozen comparisons are where the bound moves most. */
const x = (n: number) => (Math.log(n / N_MIN) / Math.log(N_MAX / N_MIN)) * 100;
const y = (v: number) => (1 - (Math.max(Y_MIN, Math.min(1, v)) - Y_MIN) / (1 - Y_MIN)) * 100;

/** The plugin's verdict reason, word for word (verdictFor in plugins/shadow/store.go). */
function reason(n: number, r: Reading): string {
  const a = (r.agreement * 100).toFixed(1);
  const lb = (r.lowerBound * 100).toFixed(1);
  switch (r.verdict) {
    case "collecting":
      return `${n} of ${DEFAULT_THRESHOLDS.minSamples} scored samples collected`;
    case "ready":
      return `agreement ${a}% (95% lower bound ${lb}%) clears 90%`;
    case "promising":
      return `agreement ${a}% clears 90% but the 95% lower bound (${lb}%) does not yet; collect more samples`;
    default:
      return `agreement ${a}% is below 90%`;
  }
}

/** Fewest comparisons at which this agreement rate clears the bar, or null if it never does. */
function crossing(rate: number): number | null {
  if (rate <= NEED) return null;
  for (let n = 1; n <= 20000; n++) {
    if (wilsonLowerBound(rate * n, n) >= NEED) return n;
  }
  return null;
}

export function Evidence() {
  const [n, setN] = useState(20);
  const [d, setD] = useState(0);

  const misses = Math.min(d, n);
  const passes = n - misses;
  const rate = passes / n;
  const reading = read({ samples: n, passes, errors: 0 });
  const clears = crossing(rate);

  const { curve, area } = useMemo(() => {
    const points: string[] = [];
    for (let i = 0; i <= 120; i++) {
      const at = N_MIN * Math.pow(N_MAX / N_MIN, i / 120);
      points.push(`${x(at).toFixed(2)},${y(wilsonLowerBound(rate * at, at)).toFixed(2)}`);
    }
    const line = `M${points.join("L")}`;
    return { curve: line, area: `${line}L100,${y(rate).toFixed(2)}L0,${y(rate).toFixed(2)}Z` };
  }, [rate]);

  return (
    <section className="section umbra evidence" id="evidence">
      <div className="wrap">
        <div className="head">
          <h2 className="h2">Twenty out of twenty is not proof.</h2>
          <p className="lede">
            A lucky streak should not promote a model. A candidate is ready only when the low end of the 95% Wilson interval around
            its agreement rate clears the bar, and its error rate stays within budget.
          </p>
        </div>

        <div className="evidence__grid">
          <div className="evidence__controls">
            <div className="evidence__presets" role="group" aria-label="Examples">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  aria-pressed={p.n === n && p.d === misses}
                  onClick={() => {
                    setN(p.n);
                    setD(p.d);
                  }}
                >
                  <b className="num">{p.label}</b>
                  {p.note && <span>{p.note}</span>}
                </button>
              ))}
            </div>

            <label className="evidence__slider">
              <span>Comparisons</span>
              <output className="num">{n}</output>
              <input
                type="range"
                min={N_MIN}
                max={N_MAX}
                value={n}
                onChange={(e) => setN(Number(e.target.value))}
                style={{ "--fill": `${((n - N_MIN) / (N_MAX - N_MIN)) * 100}%` } as CSSProperties}
              />
            </label>
            <label className="evidence__slider">
              <span>Disagreements</span>
              <output className="num">{misses}</output>
              <input
                type="range"
                min={0}
                max={Math.min(n, 80)}
                value={misses}
                onChange={(e) => setD(Number(e.target.value))}
                style={{ "--fill": `${(misses / Math.min(n, 80)) * 100}%` } as CSSProperties}
              />
            </label>

            <div className="evidence__reading" aria-live="polite">
              <span className="verdict" data-verdict={reading.verdict}>
                {VERDICT_LABEL[reading.verdict]}
              </span>
              <dl className="num">
                <div>
                  <dt>Agreement</dt>
                  <dd>{pct(reading.agreement)}</dd>
                </div>
                <div>
                  <dt>95% lower bound</dt>
                  <dd data-clear={reading.lowerBound >= NEED}>{pct(reading.lowerBound)}</dd>
                </div>
              </dl>
              <p className="evidence__reason num">{reason(n, reading)}</p>
            </div>
          </div>

          <figure className="curve">
            <figcaption>
              Lower bound as comparisons accumulate, at {pct(rate)} agreement.{" "}
              {clears === null ? (
                <b>At this rate no amount of evidence clears 90%.</b>
              ) : (
                <b className="num">It clears 90% after {clears.toLocaleString("en-US")} comparisons.</b>
              )}
            </figcaption>
            <div className="curve__plot">
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                {Y_TICKS.map((t) => (
                  <line key={t} className="curve__grid" x1="0" x2="100" y1={y(t)} y2={y(t)} />
                ))}
                <path className="curve__area" d={area} />
                <line className="curve__rate" x1="0" x2="100" y1={y(rate)} y2={y(rate)} />
                <line className="curve__need" x1="0" x2="100" y1={y(NEED)} y2={y(NEED)} />
                <path className="curve__line" d={curve} />
                <line className="curve__now" x1={x(n)} x2={x(n)} y1={y(reading.lowerBound)} y2="100" />
              </svg>

              <span className="curve__dot" data-clear={reading.lowerBound >= NEED} style={{ left: `${x(n)}%`, top: `${y(reading.lowerBound)}%` }} />
              <span className="curve__tag curve__tag--need" style={{ top: `${y(NEED)}%` }}>
                Required: 90%
              </span>
              {rate > Y_MIN && Math.abs(rate - NEED) > 0.035 && (
                <span className="curve__tag curve__tag--rate" style={{ top: `${y(rate)}%` }}>
                  Agreement
                </span>
              )}

              {Y_TICKS.map((t) => (
                <span key={t} className="curve__y num" style={{ top: `${y(t)}%` }}>
                  {t * 100}%
                </span>
              ))}
              {X_TICKS.map((t) => (
                <span key={t} className="curve__x num" style={{ left: `${x(t)}%` }}>
                  {t}
                </span>
              ))}
            </div>
            <p className="curve__axis">Comparisons, log scale</p>
          </figure>
        </div>
      </div>
    </section>
  );
}
