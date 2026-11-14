import { useId, useState, type CSSProperties } from "react";
import { HOSTED_PRICES, HOSTED_SCORECARD, JUDGE_REPLY_TOKENS, JUDGE_RUBRIC_TOKENS, type Price } from "../data/hosted";
import { wilsonLowerBound } from "../lib/stats";
import "./Savings.css";

/** The readiness bar the plugin applies (thresholds.min_agreement), and the hosted gateway's minimum sample. */
const NEED = 0.9;
const MIN_SAMPLES = HOSTED_SCORECARD.minSamples;
const DAYS_PER_MONTH = 30;

const REQ_MIN = 3; // 1,000 a month, as a power of ten
const REQ_MAX = 9; // 1,000,000,000 a month

/** Fewest comparisons at which the 95% Wilson lower bound clears the bar, at this agreement rate. */
function comparisonsNeeded(agreement: number): number | null {
  if (agreement <= NEED) return null;
  let lo = MIN_SAMPLES;
  let hi = 100_000_000;
  if (wilsonLowerBound(agreement * hi, hi) < NEED) return null;
  // The bound rises with n at a fixed rate above the bar, so a binary search finds the crossing.
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (wilsonLowerBound(agreement * mid, mid) >= NEED) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const perMillion = (tokens: number, price: number) => (tokens * price) / 1_000_000;

interface Inputs {
  requests: number;
  inTokens: number;
  outTokens: number;
  current: Price;
  candidate: Price;
  sampleRate: number;
  agreement: number;
}

function compute(x: Inputs) {
  const perRequestNow = perMillion(x.inTokens, x.current.input) + perMillion(x.outTokens, x.current.output);
  const perRequestAfter = perMillion(x.inTokens, x.candidate.input) + perMillion(x.outTokens, x.candidate.output);
  const now = x.requests * perRequestNow;
  const after = x.requests * perRequestAfter;
  const saving = now - after;

  // One comparison: the candidate answers, then the judge (your current model) reads the rubric, the request and both answers.
  const judgeIn = JUDGE_RUBRIC_TOKENS + x.inTokens + 2 * x.outTokens;
  const judgeCall = perMillion(judgeIn, x.current.input) + perMillion(JUDGE_REPLY_TOKENS, x.current.output);
  const perComparison = perRequestAfter + judgeCall;

  const needed = comparisonsNeeded(x.agreement);
  const perDay = (x.requests / DAYS_PER_MONTH) * x.sampleRate;
  const days = needed === null || perDay <= 0 ? null : needed / perDay;
  const evalSpend = needed === null ? null : needed * perComparison;
  const paybackDays = evalSpend === null || saving <= 0 ? null : evalSpend / (saving / DAYS_PER_MONTH);

  return { perRequestNow, perRequestAfter, now, after, saving, perComparison, needed, perDay, days, evalSpend, paybackDays };
}

/* ------------------------------------------------------------------ formatting */

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function money(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 10) return `$${whole.format(v)}`;
  if (abs >= 0.01) return `$${v.toFixed(2)}`;
  if (abs === 0) return "$0";
  return `$${Number(v.toPrecision(2))}`;
}

/** Splits a duration into a figure and its unit, for display at two sizes. */
function duration(days: number): [string, string] {
  const minutes = days * 24 * 60;
  if (minutes < 1) return ["under 1", "minute"];
  if (minutes < 90) return [whole.format(minutes), minutes < 1.5 ? "minute" : "minutes"];
  const hours = minutes / 60;
  if (hours < 48) return [hours < 10 ? hours.toFixed(1) : whole.format(hours), "hours"];
  if (days < 120) return [days < 10 ? days.toFixed(1) : whole.format(days), "days"];
  if (days < 730) return [(days / 30.4).toFixed(1), "months"];
  return [(days / 365).toFixed(1), "years"];
}

function nice(n: number): number {
  return Number(n.toPrecision(2));
}

/* ------------------------------------------------------------------ controls */

function NumberField({
  id,
  value,
  onChange,
  min,
  max,
  label,
  unit,
}: {
  id: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  label: string;
  unit?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  return (
    <span className="calc-num">
      <input
        id={id}
        type="text"
        inputMode="numeric"
        aria-label={label}
        value={draft ?? whole.format(value)}
        onFocus={(e) => {
          setDraft(String(value));
          requestAnimationFrame(() => e.target.select());
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          const parsed = Number(e.target.value.replace(/[^\d.]/g, ""));
          if (e.target.value.trim() !== "" && Number.isFinite(parsed) && parsed >= min) onChange(clamp(parsed));
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {unit && <span className="calc-num__unit">{unit}</span>}
    </span>
  );
}

function Slider({
  value,
  min,
  max,
  step,
  onChange,
  label,
  valueText,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  label: string;
  valueText: string;
}) {
  return (
    <input
      className="calc-slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      aria-valuetext={valueText}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ "--fill": `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
    />
  );
}

function ModelPicker({
  legend,
  name,
  prices,
  value,
  onChange,
  disabled,
}: {
  legend: string;
  name: string;
  prices: Price[];
  value: string;
  onChange: (model: string) => void;
  disabled?: string;
}) {
  return (
    <fieldset className="calc-pick">
      <legend>{legend}</legend>
      <div className="calc-pick__options">
        {prices.map((p) => (
          <label key={p.model} data-disabled={p.model === disabled}>
            <input
              type="radio"
              name={name}
              value={p.model}
              checked={value === p.model}
              disabled={p.model === disabled}
              onChange={() => onChange(p.model)}
            />
            <span className="model">{p.model.replace(/^claude-/, "")}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Lower bound against comparisons at the expected agreement, with the point it clears the bar. */
function ProofCurve({ agreement, needed }: { agreement: number; needed: number | null }) {
  const xMax = Math.max(60, Math.ceil(((needed ?? 200) * 1.5) / 10) * 10);
  const yMin = 0.6;
  const x = (n: number) => (n / xMax) * 100;
  const y = (v: number) => (1 - (Math.max(yMin, Math.min(1, v)) - yMin) / (1 - yMin)) * 100;

  const pts: string[] = [];
  for (let i = 0; i <= 80; i++) {
    const n = Math.max(1, (i / 80) * xMax);
    pts.push(`${x(n).toFixed(2)},${y(wilsonLowerBound(agreement * n, n)).toFixed(2)}`);
  }
  const path = `M${pts.join("L")}`;

  const lbAtNeed = needed === null ? null : wilsonLowerBound(agreement * needed, needed);

  return (
    <figure className="calc-curve" aria-hidden="true">
      <div className="calc-curve__plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none">
          <line className="calc-curve__rate" x1="0" x2="100" y1={y(agreement)} y2={y(agreement)} />
          <line className="calc-curve__need" x1="0" x2="100" y1={y(NEED)} y2={y(NEED)} />
          <path className="calc-curve__line" d={path} />
          {needed !== null && <line className="calc-curve__at" x1={x(needed)} x2={x(needed)} y1={y(NEED)} y2="100" />}
        </svg>
        {needed !== null && lbAtNeed !== null && (
          <span className="calc-curve__dot" style={{ left: `${x(needed)}%`, top: `${y(lbAtNeed)}%` }} />
        )}
        <span className="calc-curve__tag" style={{ top: `${y(NEED)}%` }}>
          90% bar
        </span>
        <span className="calc-curve__x num" style={{ left: 0 }}>
          0
        </span>
        <span className="calc-curve__x calc-curve__x--end num" style={{ left: "100%" }}>
          {whole.format(xMax)}
        </span>
      </div>
      <p className="calc-curve__caption">95% lower bound as comparisons accumulate</p>
    </figure>
  );
}

/* ------------------------------------------------------------------ the calculator */

export function Savings() {
  const uid = useId();
  const [requests, setRequests] = useState(200_000);
  const [inTokens, setInTokens] = useState(1_200);
  const [outTokens, setOutTokens] = useState(300);
  const [prices, setPrices] = useState<Price[]>(HOSTED_PRICES);
  const [currentId, setCurrentId] = useState("claude-opus-5-5");
  const [candidateId, setCandidateId] = useState("claude-haiku-5-5");
  const [sampleRate, setSampleRate] = useState(0.1);
  const [agreement, setAgreement] = useState(0.97);

  const current = prices.find((p) => p.model === currentId) ?? prices[0];
  const candidate = prices.find((p) => p.model === candidateId) ?? prices[prices.length - 1];
  const r = compute({ requests, inTokens, outTokens, current, candidate, sampleRate, agreement });

  const chooseCurrent = (model: string) => {
    setCurrentId(model);
    if (model === candidateId) setCandidateId(prices.find((p) => p.model !== model)!.model);
  };

  const setPrice = (model: string, key: "input" | "output", value: number) =>
    setPrices((list) => list.map((p) => (p.model === model ? { ...p, [key]: value } : p)));

  const edited = prices.some((p, i) => p.input !== HOSTED_PRICES[i].input || p.output !== HOSTED_PRICES[i].output);
  const cheaper = r.saving > 0;
  const afterShare = r.now > 0 ? Math.min(1, r.after / r.now) : 0;
  const ratePct = Math.round(sampleRate * 100);
  const [daysFig, daysUnit] = r.days === null ? ["", ""] : duration(r.days);
  const [payFig, payUnit] = r.paybackDays === null ? ["", ""] : duration(r.paybackDays);

  return (
    <section className="section savings" id="savings">
      <div className="wrap">
        <div className="head">
          <h2 className="h2">What would switching save you?</h2>
          <p className="lede">
            Put in your traffic. The calculator prices the switch, then works out what it costs to prove the cheaper model first: how
            many comparisons the statistics need, how long your traffic takes to supply them, and what the evaluation spends.
          </p>
        </div>

        <div className="calc">
          <form className="calc__in" onSubmit={(e) => e.preventDefault()} aria-label="Your traffic">
            <div className="calc-row">
              <label className="calc-row__label" htmlFor={`${uid}-req`}>
                Requests a month
              </label>
              <NumberField id={`${uid}-req`} label="Requests a month" value={requests} onChange={setRequests} min={1} max={10_000_000_000} />
              <Slider
                label="Requests a month, on a log scale"
                value={Math.log10(Math.max(10 ** REQ_MIN, Math.min(10 ** REQ_MAX, requests)))}
                min={REQ_MIN}
                max={REQ_MAX}
                step={0.01}
                onChange={(v) => setRequests(nice(10 ** v))}
                valueText={`${whole.format(requests)} requests a month`}
              />
              <span className="calc-row__scale num" aria-hidden="true">
                <span>1K</span>
                <span>1M</span>
                <span>1B</span>
              </span>
            </div>

            <div className="calc-pair">
              <div className="calc-row">
                <label className="calc-row__label" htmlFor={`${uid}-in`}>
                  Input tokens
                </label>
                <NumberField id={`${uid}-in`} label="Average input tokens per request" value={inTokens} onChange={setInTokens} min={1} max={1_000_000} unit="avg" />
              </div>
              <div className="calc-row">
                <label className="calc-row__label" htmlFor={`${uid}-out`}>
                  Output tokens
                </label>
                <NumberField id={`${uid}-out`} label="Average output tokens per request" value={outTokens} onChange={setOutTokens} min={1} max={1_000_000} unit="avg" />
              </div>
            </div>

            <ModelPicker legend="You run" name={`${uid}-current`} prices={prices} value={currentId} onChange={chooseCurrent} />
            <ModelPicker
              legend="You want to try"
              name={`${uid}-candidate`}
              prices={prices}
              value={candidateId}
              onChange={setCandidateId}
              disabled={currentId}
            />

            <div className="calc-row">
              <span className="calc-row__label" id={`${uid}-rate`}>
                Shadow sample rate
              </span>
              <output className="calc-row__value num" aria-labelledby={`${uid}-rate`}>
                {ratePct}%
              </output>
              <Slider
                label="Shadow sample rate"
                value={ratePct}
                min={1}
                max={100}
                step={1}
                onChange={(v) => setSampleRate(v / 100)}
                valueText={`${ratePct}% of requests`}
              />
            </div>

            <div className="calc-row">
              <span className="calc-row__label" id={`${uid}-agree`}>
                Expected agreement
              </span>
              <output className="calc-row__value num" aria-labelledby={`${uid}-agree`}>
                {(agreement * 100).toFixed(1)}%
              </output>
              <Slider
                label="Expected agreement with your current model"
                value={agreement * 100}
                min={88}
                max={100}
                step={0.5}
                onChange={(v) => setAgreement(v / 100)}
                valueText={`${(agreement * 100).toFixed(1)}%`}
              />
              <p className="calc-row__hint">
                How often you expect the judge to find the candidate as good. The hosted gateway measured{" "}
                {HOSTED_SCORECARD.rows[1].passes} of {HOSTED_SCORECARD.compared} for Haiku against Opus.
              </p>
            </div>

            <details className="calc-prices">
              <summary>Prices per million tokens{edited ? ", edited" : ""}</summary>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Input</th>
                    <th scope="col">Output</th>
                  </tr>
                </thead>
                <tbody>
                  {prices.map((p) => (
                    <tr key={p.model}>
                      <th scope="row" className="model">
                        {p.model}
                      </th>
                      {(["input", "output"] as const).map((key) => (
                        <td key={key}>
                          <span className="calc-price">
                            $
                            <input
                              type="number"
                              min={0}
                              step="any"
                              value={p[key]}
                              aria-label={`${p.model} ${key} price per million tokens`}
                              onChange={(e) => {
                                const v = Number(e.target.value);
                                if (e.target.value !== "" && Number.isFinite(v) && v >= 0) setPrice(p.model, key, v);
                              }}
                            />
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                The prices the hosted gateway charged, fitted from its 490 recorded calls.{" "}
                {edited && (
                  <button type="button" className="calc-prices__reset" onClick={() => setPrices(HOSTED_PRICES)}>
                    Reset them
                  </button>
                )}
              </p>
            </details>
          </form>

          <div className="calc__out">
            <div className="calc-save">
              <p className="calc-save__label">{cheaper ? "You would save" : "Switching would cost you"}</p>
              <p className="calc-save__figure num">
                {money(Math.abs(r.saving))}
                <span> a month</span>
              </p>
              <p className="calc-save__sub num">
                {cheaper ? (
                  <>
                    {money(r.saving * 12)} a year, {Math.round((r.saving / r.now) * 100)}% off the model bill
                  </>
                ) : (
                  <>That candidate costs more per request than the model you run.</>
                )}
              </p>

              <div className="calc-bars num" aria-hidden="true">
                <div className="calc-bars__row">
                  <span className="calc-bars__name">
                    Now, <span className="model">{current.model}</span>
                  </span>
                  <span className="calc-bars__track">
                    <i style={{ width: r.after > r.now ? `${(r.now / r.after) * 100}%` : "100%" }} />
                  </span>
                  <span className="calc-bars__value">{money(r.now)}</span>
                </div>
                <div className="calc-bars__row" data-after>
                  <span className="calc-bars__name">
                    After, <span className="model">{candidate.model}</span>
                  </span>
                  <span className="calc-bars__track">
                    <i style={{ width: r.after > r.now ? "100%" : `max(3px, ${afterShare * 100}%)` }} />
                  </span>
                  <span className="calc-bars__value">{money(r.after)}</span>
                </div>
              </div>
              <p className="sr-only">
                Monthly model bill now {money(r.now)}, after the switch {money(r.after)}.
              </p>
            </div>

            <div className="calc-proof">
              <h3 className="h3">The cost of proving it first</h3>
              <p className="calc-proof__lede">
                {r.needed === null ? (
                  <>At {(agreement * 100).toFixed(1)}% agreement or less, no amount of evidence clears the 90% bar. RelayProof would keep the candidate out.</>
                ) : (
                  <>
                    At {(agreement * 100).toFixed(1)}% agreement, the 95% lower bound clears 90% after{" "}
                    <b className="num">{whole.format(r.needed)}</b> comparisons. Each one costs a {candidate.model.replace(/^claude-/, "")} call and a
                    judge call on {current.model.replace(/^claude-/, "")}: ${Number(r.perComparison.toPrecision(2))}.
                  </>
                )}
              </p>

              <dl className="calc-figs num">
                <div>
                  <dt>Comparisons needed</dt>
                  <dd>{r.needed === null ? "Never" : whole.format(r.needed)}</dd>
                </div>
                <div>
                  <dt>Of your traffic, at {ratePct}%</dt>
                  <dd>
                    {r.days === null ? "Never" : daysFig}
                    {r.days !== null && <small> {daysUnit}</small>}
                  </dd>
                </div>
                <div>
                  <dt>Evaluation spend</dt>
                  <dd>{r.evalSpend === null ? "None" : money(r.evalSpend)}</dd>
                </div>
                <div>
                  <dt>Paid back in</dt>
                  <dd>
                    {r.paybackDays === null ? "Never" : payFig}
                    {r.paybackDays !== null && <small> {payUnit}</small>}
                  </dd>
                </div>
              </dl>

              <ProofCurve agreement={agreement} needed={r.needed} />
            </div>

            <p className="calc__fine">
              Assumes the candidate writes as many tokens as your current model, one judge call per comparison on your current model
              (its rubric, the request and both answers), and 30-day months. The plugin also needs at least {MIN_SAMPLES} comparisons and
              an error rate within budget before it calls a candidate ready.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
