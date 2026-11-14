import { useState } from "react";
import { TrafficSim } from "./TrafficSim";
import "./HowItWorks.css";

const STAGES = [
  {
    name: "Mirror",
    body: "Once your user has the answer, a sample of requests is sent again to the cheaper models you want to try.",
  },
  {
    name: "Judge",
    body: "An LLM judge scores both answers without knowing which is which. Tool calls and JSON shape are checked exactly.",
  },
  {
    name: "Prove",
    body: "Each candidate keeps a scorecard. It is ready only when the 95% lower bound of its agreement clears 90%.",
  },
  {
    name: "Promote",
    body: "One API call gives a ready candidate a weighted share of real traffic, 10% for a start.",
  },
  {
    name: "Guard",
    body: "If the canary's live error rate or latency turns bad, the gateway rolls it back by itself and logs why.",
  },
];

const STEPS = [
  { title: "Match and sample", body: "The request is checked against the experiment, the virtual-key allow-list and the x-bf-shadow header, then sampled. Unsampled requests cost about 100 ns." },
  { title: "Capture", body: "A sampled request is snapshotted once and held by request ID. A stream is collected chunk by chunk." },
  { title: "Hand off", body: "When the answer is complete, one job per candidate goes onto a bounded queue. The caller never waits." },
  { title: "Replay", body: "A worker sends the same messages, tools and parameters to the candidate as an internal request: no plugins, no billing to the caller, no MCP tools." },
  { title: "Compare", body: "Lexical, length and finish-reason checks, tool-call and JSON matching, then an optional LLM judge with the two answers in random order." },
  { title: "Decide", body: "A different tool or a broken JSON shape fails the pair. Otherwise the strongest signal decides; with none, the pair stays unscored." },
  { title: "Report", body: "The record lands in a ring buffer, optionally a JSONL file, and rolls up into the candidate's scorecard." },
];

/** One request from the key-free demo run, as the plugin handles it. `step` ties a line to the step that produces it. */
const TRACE: { at: string; who: string; what: string; step: number | null }[] = [
  { at: "0 ms", who: "PreLLMHook", what: 'matched "gpt-4o cost-down", sampled', step: 0 },
  { at: "", who: "capture", what: "request snapshot stored by request ID", step: 1 },
  { at: "319 ms", who: "primary", what: "openai/gpt-4o answered, 32 tokens in, 39 out", step: null },
  { at: "", who: "caller", what: "answer sent, x-bf-shadow: sampled", step: null },
  { at: "", who: "PostLLMHook", what: "2 jobs queued, one per candidate", step: 2 },
  { at: "later", who: "replay", what: "openai/llama-3.1-8b, internal request, 48 ms", step: 3 },
  { at: "", who: "compare", what: "lexical 11.1%, semantic 44.7%, length ratio 0.24", step: 4 },
  { at: "", who: "judge", what: "primary 9, candidate 2, candidate shown as B", step: 4 },
  { at: "", who: "decide", what: "fail, decided by the judge", step: 5 },
  { at: "", who: "scorecard", what: "llama-3.1-8b: one more disagreement", step: 6 },
];

function Trace() {
  const [active, setActive] = useState(0);

  return (
    <div className="trace-grid">
      <figure className="trace umbra" aria-label="Trace of one sampled request">
        <figcaption className="trace__head">
          <span className="model">838d51f7</span>
          <span>POST /v1/chat/completions</span>
        </figcaption>
        <ol className="trace__lines">
          {TRACE.map((line) => (
            <li key={line.who + line.what} data-on={line.step === active}>
              <span className="trace__at">{line.at}</span>
              <span className="trace__who">{line.who}</span>
              <span className="trace__what">{line.what}</span>
            </li>
          ))}
        </ol>
      </figure>

      <ol className="trace-steps">
        {STEPS.map((step, i) => (
          <li key={step.title}>
            <button
              type="button"
              aria-pressed={i === active}
              onClick={() => setActive(i)}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
            >
              <span className="trace-steps__n num" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <b>{step.title}</b>
                <span className="trace-steps__body">{step.body}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function HowItWorks() {
  return (
    <section className="section how" id="how">
      <div className="wrap">
        <div className="head">
          <h2 className="h2">Your users never wait for the test.</h2>
          <p className="lede">
            RelayProof runs inside the gateway, after the response has gone out. Five steps take a candidate from its first shadow call
            to serving real traffic, and back out again if it misbehaves.
          </p>
        </div>

        <ol className="stages">
          {STAGES.map((stage, i) => (
            <li key={stage.name}>
              <span className="stages__n num" aria-hidden="true">
                {i + 1}
              </span>
              <h3 className="h3">{stage.name}</h3>
              <p>{stage.body}</p>
            </li>
          ))}
        </ol>

        <div className="how__sim">
          <div className="how__sim-head">
            <h3 className="h3">Watch both paths at once</h3>
            <p>
              A simulation of the key-free demo. Raise the sample rate and the evidence piles up faster; once the lower bound clears
              90%, promote the candidate and watch part of the traffic move to it.
            </p>
          </div>
          <TrafficSim />
        </div>

        <details className="how__more">
          <summary>
            <span className="h3">Follow one request through the plugin</span>
            <span className="how__more-hint">Seven steps, from the gateway hook to the scorecard</span>
          </summary>
          <Trace />
        </details>
      </div>
    </section>
  );
}
