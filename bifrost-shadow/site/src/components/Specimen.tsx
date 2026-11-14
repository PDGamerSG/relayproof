import { useRef, useState, type KeyboardEvent } from "react";
import { HOSTED_SCORECARD, PRIMARY, SPECIMENS, type Reply, type ShadowRun, type Specimen as SpecimenData } from "../data/hosted";
import "./Specimen.css";

const SHORT: Record<string, string> = {
  "claude-opus-5-5": "Opus",
  "claude-sonnet-5-5": "Sonnet",
  "claude-haiku-5-5": "Haiku",
};

function when(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

function usd(value: number): string {
  // Two significant figures: these are fractions of a cent.
  return `$${Number(value.toPrecision(2))}`;
}

function ms(value: number): string {
  return `${value.toLocaleString("en-US")} ms`;
}

function ReplyBody({ reply }: { reply: Reply }) {
  if (reply.kind === "tool") {
    return (
      <pre className="spec__code">
        <code>
          {reply.name}({reply.args})
        </code>
      </pre>
    );
  }
  const fenced = reply.text.match(/^```\w*\n([\s\S]*?)\n```$/);
  if (fenced) {
    return (
      <pre className="spec__code">
        <code>{fenced[1]}</code>
      </pre>
    );
  }
  return <p className="spec__text">{reply.text}</p>;
}

/** The plugin's pass rule for a judged pair: the candidate may trail the primary by one point. */
function outcome(run: ShadowRun): string {
  const { primary, candidate } = run.judge;
  if (candidate > primary) return `beat ${SHORT[PRIMARY]}`;
  if (candidate === primary) return `tied with ${SHORT[PRIMARY]}`;
  if (run.pass) return `within a point of ${SHORT[PRIMARY]}`;
  return `trailed ${SHORT[PRIMARY]}`;
}

function Candidate({ run, specimen }: { run: ShadowRun; specimen: SpecimenData }) {
  const cheaper = 1 - run.costUsd / specimen.primary.costUsd;
  const name = SHORT[run.model];
  const [a, b] = run.judge.candidateShownFirst ? [name, SHORT[PRIMARY]] : [SHORT[PRIMARY], name];

  return (
    <article className="cand-run">
      <header className="cand-run__head">
        <span className="model">{run.model}</span>
        <span className="cand-run__outcome">
          {outcome(run)}
          <span className="verdict" data-verdict={run.pass ? "ready" : "not_ready"}>
            {run.pass ? "Pass" : "Fail"}
          </span>
        </span>
      </header>

      <ReplyBody reply={run.reply} />

      <dl className="cand-run__facts num">
        <div className="cand-run__score">
          <dt>Judge score</dt>
          <dd>
            <b>{run.judge.candidate}</b>
            <span>/10</span>
          </dd>
          <dd className="cand-run__sub">
            {SHORT[PRIMARY]} scored {run.judge.primary}
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>
            <b>{Math.round(cheaper * 100)}%</b> <span>cheaper</span>
          </dd>
          <dd className="cand-run__sub">
            {usd(run.costUsd)} against {usd(specimen.primary.costUsd)}
          </dd>
        </div>
        <div>
          <dt>Latency</dt>
          <dd>
            <b>{(run.latencyMs / 1000).toFixed(1)}</b> <span>s</span>
          </dd>
          <dd className="cand-run__sub">
            {SHORT[PRIMARY]} took {(specimen.primary.latencyMs / 1000).toFixed(1)} s
          </dd>
        </div>
      </dl>

      <p className="cand-run__reason">
        <span className="cand-run__key">
          Judge, shown {a} as A and {b} as B:
        </span>{" "}
        &ldquo;{run.judge.reason}&rdquo;
      </p>
      {run.check && <p className="cand-run__check">{run.check}</p>}
    </article>
  );
}

export function Specimen() {
  const [index, setIndex] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const s = SPECIMENS[index];

  const select = (i: number) => {
    const next = (i + SPECIMENS.length) % SPECIMENS.length;
    setIndex(next);
    tabs.current[next]?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") select(index + 1);
    else if (e.key === "ArrowLeft") select(index - 1);
    else if (e.key === "Home") select(0);
    else if (e.key === "End") select(SPECIMENS.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <figure className="spec" aria-labelledby="spec-title">
      <div className="spec__bar">
        <p className="spec__title" id="spec-title">
          Real requests from the hosted gateway
        </p>
        <div className="spec__tabs" role="tablist" aria-label="Recorded requests" onKeyDown={onKey}>
          {SPECIMENS.map((sp, i) => (
            <button
              key={sp.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              id={`spec-tab-${sp.id}`}
              type="button"
              role="tab"
              aria-selected={i === index}
              aria-controls="spec-panel"
              tabIndex={i === index ? 0 : -1}
              onClick={() => setIndex(i)}
            >
              {sp.label}
            </button>
          ))}
        </div>
      </div>

      <div className="spec__panel" id="spec-panel" role="tabpanel" aria-labelledby={`spec-tab-${s.id}`} key={s.id}>
        <div className="spec__lit">
          <div className="spec__ask">
            <h3 className="spec__lane">The request</h3>
            <p className="spec__prompt">{s.prompt}</p>
            <p className="spec__when">
              <time dateTime={s.at}>{when(s.at)}</time>
              <br />
              Request <span className="model">{s.requestId}</span>
            </p>
          </div>

          <div className="spec__served">
            <header className="spec__served-head">
              <h3 className="spec__lane">What your user got</h3>
              <span className="model">{PRIMARY}</span>
            </header>
            <ReplyBody reply={s.primary.reply} />
            <p className="spec__served-meta num">
              Answered in {ms(s.primary.latencyMs)} for {usd(s.primary.costUsd)}
            </p>
          </div>
        </div>

        <div className="spec__shade umbra">
          <header className="spec__shade-head">
            <h3 className="spec__lane">Tested in the shadow</h3>
            <p>After the answer was sent, the same request went to two cheaper models. Your user never waited for them.</p>
          </header>
          <div className="spec__cands">
            {s.shadow.map((run) => (
              <Candidate key={run.model} run={run} specimen={s} />
            ))}
          </div>
        </div>
      </div>

      <figcaption className="spec__foot">
        <p className="spec__foot-lead">
          After {HOSTED_SCORECARD.compared} requests like these, both candidates agreed with {SHORT[PRIMARY]} every time.
        </p>
        <ul className="spec__score num">
          {HOSTED_SCORECARD.rows.map((row) => (
            <li key={row.model}>
              <span className="model">{row.model}</span>
              <span className="verdict" data-verdict="ready">
                Ready
              </span>
              <span>
                {row.passes} of {HOSTED_SCORECARD.compared} agree, lower bound {(row.lowerBound * 100).toFixed(1)}%
              </span>
              <span className="spec__score-save">{row.savingsPct}% cheaper</span>
            </li>
          ))}
        </ul>
        <p className="spec__note">Answers are shown as recorded, typos included.</p>
      </figcaption>
    </figure>
  );
}
