import { useEffect, useRef, useState, type FormEvent } from "react";
import { errorText, ms, useConnection, type AskResponse, type DemoStatus } from "./backend";
import type { ShadowRecord } from "./shadowClient";

const EXAMPLES = [
  "What is the capital of Australia?",
  "What is 17 * 23?",
  "Explain in one sentence why the sky is blue.",
  'Extract the name and email as JSON: "Contact Priya Raman at priya@example.com".',
];

const BASIS: Record<string, string> = {
  judge: "judge",
  exact: "exact match",
  semantic: "embeddings",
  lexical: "lexical",
  tool_selection: "wrong tool",
  json_schema: "JSON shape",
  tool_arguments: "tool arguments",
  unscored: "unscored",
};

/**
 * Ask the gateway: a visitor's own question goes to the primary model through
 * the hosted gateway, forced into the shadow path, so every candidate answers it
 * too and the judge scores each pair. The panel shows the primary answer at
 * once, then each candidate's result as its shadow record lands.
 */
export function AskPanel({ status }: { status?: DemoStatus }) {
  const { client, demo } = useConnection();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [answer, setAnswer] = useState<AskResponse>();
  const [question, setQuestion] = useState("");
  const [records, setRecords] = useState<ShadowRecord[]>([]);
  const [waiting, setWaiting] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);

  const maxChars = status?.ask_max_chars ?? 600;
  const candidates = status?.incident_models ?? [];

  useEffect(() => () => window.clearInterval(pollRef.current), []);

  const watch = (id: string) => {
    window.clearInterval(pollRef.current);
    if (!id) return;
    setWaiting(true);
    const started = Date.now();
    const tick = async () => {
      try {
        const page = await client.records({ limit: 30 });
        const mine = page.records.filter((r) => r.request_id === id);
        setRecords(mine);
        const done = candidates.length > 0 ? mine.length >= candidates.length : mine.length > 0;
        if (done || Date.now() - started > 120_000) {
          window.clearInterval(pollRef.current);
          setWaiting(false);
        }
      } catch {
        // Keep polling; a slow comparison is not an error.
      }
    };
    void tick();
    pollRef.current = window.setInterval(tick, 1500);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!demo) return;
    const q = prompt.trim();
    if (!q) return;
    setBusy(true);
    setError(undefined);
    setAnswer(undefined);
    setRecords([]);
    setQuestion(q);
    try {
      const res = await demo.ask(q);
      setAnswer(res);
      watch(res.request_id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const real = status?.upstream && status.upstream !== "mock";
  const primary = status?.primary_model ?? "the primary model";

  return (
    <section className="wrap lv-section lv-ask" id="ask" aria-labelledby="ask-h">
      <div className="lv-head">
        <h2 className="lv-h2" id="ask-h">
          Ask the gateway
        </h2>
        <p className="muted small">
          Your question goes to <span className="model">{primary}</span>, the model this gateway serves. The shadow plugin then sends the
          same question to {candidates.length > 0 ? candidates.map((c, i) => (
            <span key={c}>
              {i > 0 && (i === candidates.length - 1 ? " and " : ", ")}
              <span className="model">{c}</span>
            </span>
          )) : "each candidate"}{" "}
          after the answer has gone out, and a judge scores each pair.{" "}
          {real ? "These are real model calls." : "In this mode a mock plays every model."} Questions are stored in this public demo&rsquo;s
          records, so do not type anything private.
        </p>
      </div>

      <form className="lv-ask__form" onSubmit={submit}>
        <label className="sr-only" htmlFor="ask-prompt">
          Your question
        </label>
        <textarea
          id="ask-prompt"
          rows={2}
          maxLength={maxChars}
          placeholder="Ask anything, for example: What is the capital of Australia?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
          }}
        />
        <div className="lv-ask__row">
          <div className="lv-ask__examples">
            {EXAMPLES.map((x) => (
              <button key={x} type="button" className="lv-chip" onClick={() => setPrompt(x)}>
                {x.length > 42 ? `${x.slice(0, 40)}…` : x}
              </button>
            ))}
          </div>
          <button type="submit" className="btn btn--sun btn--small" disabled={busy || !prompt.trim()}>
            {busy ? "Asking…" : "Ask"}
          </button>
        </div>
        {error && (
          <p className="lv-error small" role="alert">
            {error}
          </p>
        )}
      </form>

      {(answer || busy) && (
        <div className="lv-ask__out" aria-live="polite">
          {question && <p className="lv-ask__q">&ldquo;{question}&rdquo;</p>}
          <article className="lv-ask__card" data-role="primary">
            <header className="small">
              <b>Primary</b> <span className="model">{answer?.model ?? primary}</span>
              {answer && <span className="muted num"> · {ms(answer.latency_ms)} · served to the caller</span>}
            </header>
            <p className="lv-ask__text">{answer ? answer.answer || "(no text)" : "Waiting for the answer…"}</p>
          </article>
          {answer && !answer.shadowed && (
            <p className="small muted">The plugin did not mirror this request (budget reached or queue full), so no candidate answered it.</p>
          )}
          {answer?.shadowed &&
            (candidates.length > 0 ? candidates : records.map((r) => r.candidate.model)).map((model) => {
              const r = records.find((x) => x.candidate.model === model);
              return (
                <article key={model} className="lv-ask__card" data-role="candidate" data-pass={r ? (r.candidate_error ? "error" : String(r.pass)) : undefined}>
                  <header className="small">
                    <b>Shadow</b> <span className="model">{model}</span>
                    {r && !r.candidate_error && <span className="muted num"> · {ms(r.candidate_latency_ms)}</span>}
                    {r && (
                      <span className="lv-ask__verdict">
                        {r.candidate_error ? "Error" : r.pass ? "Agrees" : "Disagrees"}
                        {r.pass_basis && !r.candidate_error ? ` · ${BASIS[r.pass_basis] ?? r.pass_basis}` : ""}
                      </span>
                    )}
                  </header>
                  {!r && <p className="lv-ask__text muted">{waiting ? "Replaying in the shadow…" : "No record yet."}</p>}
                  {r?.candidate_error && <p className="lv-ask__text lv-error">{r.candidate_error}</p>}
                  {r && !r.candidate_error && (
                    <p className="lv-ask__text">
                      {r.candidate_answer?.text ||
                        r.candidate_answer?.tool_calls?.map((t) => `${t.name}(${t.arguments})`).join("\n") ||
                        "(no text)"}
                    </p>
                  )}
                  {r?.judge && (
                    <p className="small muted num">
                      Judge: primary {r.judge.primary_score}, candidate {r.judge.candidate_score}
                      {r.judge.reason ? ` · “${r.judge.reason}”` : ""}
                    </p>
                  )}
                  {r?.judge_error && <p className="small lv-error">Judge call failed: {r.judge_error}</p>}
                </article>
              );
            })}
        </div>
      )}
    </section>
  );
}
