import { useEffect, useRef, useState } from "react";
import "./HowItWorks.css";

const STEPS = [
  {
    title: "Match and sample",
    body: "Each chat completion, streamed or not, is checked against the experiment's source model, the virtual-key allow-list and the x-bf-shadow header, then sampled at the experiment's rate. A request that is not sampled costs about 100 ns and no allocations.",
  },
  {
    title: "Capture",
    body: "A sampled request is snapshotted once. The capture lives in the plugin, keyed by request ID, never in the request context. A stream is accumulated chunk by chunk until its final chunk.",
  },
  {
    title: "Hand off",
    body: "When the primary answer is complete, one job per candidate goes onto a bounded queue. A full queue drops the job and counts it. The answer to the caller never waits.",
  },
  {
    title: "Replay",
    body: "A worker sends the same messages, tools and parameters to the candidate as an internal request. It skips the plugin pipeline, is not billed to the caller's virtual key, and runs no MCP tools.",
  },
  {
    title: "Compare",
    body: "Every pair gets lexical similarity, a length ratio and a finish-reason check, plus tool-call and JSON-structure matching when they apply. An optional LLM judge scores both answers, shown in a random order to cancel position bias.",
  },
  {
    title: "Decide",
    body: "The pair passes or fails on the strongest signal available: the judge, then tool calls, then JSON shape, then embeddings, then lexical overlap. A candidate error is a failure.",
  },
  {
    title: "Report",
    body: "The record goes into a bounded ring buffer, optionally a JSONL file, and rolls up into the candidate's scorecard.",
  },
];

/** One request from the demo run, as the plugin handles it. `step` ties a line to the step that produces it. */
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

export function HowItWorks() {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLOListElement>(null);

  // The step nearest the middle of the viewport is the active one.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = Array.from(list.children) as HTMLElement[];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(items.indexOf(entry.target as HTMLElement));
        }
      },
      { rootMargin: "-46% 0px -46% 0px" },
    );
    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, []);

  return (
    <section className="section umbra how" id="how">
      <div className="wrap">
        <div className="head">
          <h2 className="h2">The life of one sampled request</h2>
          <p className="lede">
            Seven steps, none of them on the request path. The trace follows one request from the demo run: answered by gpt-4o, then
            replayed against llama-3.1-8b in the background.
          </p>
        </div>

        <div className="how__grid">
          <figure className="trace" aria-label="Trace of one sampled request">
            <figcaption className="trace__head">
              <span className="model">838d51f7</span>
              <span>POST /v1/chat/completions</span>
            </figcaption>
            <ol className="trace__lines">
              {TRACE.map((line) => (
                <li key={line.who + line.what} data-on={line.step === active} data-plain={line.step === null}>
                  <span className="trace__at">{line.at}</span>
                  <span className="trace__who">{line.who}</span>
                  <span className="trace__what">{line.what}</span>
                </li>
              ))}
            </ol>
          </figure>

          <ol className="steps" ref={listRef}>
            {STEPS.map((step, i) => (
              <li key={step.title} className="steps__item" data-on={i === active}>
                <span className="steps__n" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <h3 className="h3">{step.title}</h3>
                  <p>{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
