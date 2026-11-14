import { useEffect, useMemo, useRef, useState } from "react";
import { wilsonLowerBound } from "../lib/stats";
import { ago, count, modelId, ms, pct } from "./backend";
import { wordDiff } from "./diff";
import { counts, median, type RecordsState } from "./records";
import type { Answer, PassBasis, ShadowRecord, Summary } from "./shadowClient";
import "./explorer.css";

type Outcome = "all" | "pass" | "fail" | "error" | "unscored";
type Sort = "newest" | "oldest" | "gap" | "slowest";

const BASIS: Record<PassBasis, string> = {
  judge: "Judge",
  exact: "Exact match",
  semantic: "Embeddings",
  lexical: "Lexical overlap",
  tool_selection: "Different tool",
  json_schema: "JSON shape",
  tool_arguments: "Tool arguments",
  unscored: "No usable signal",
  structural: "Structural",
};

const PAGE = 60;

export function outcomeOf(r: ShadowRecord): Exclude<Outcome, "all"> {
  if (r.candidate_error) return "error";
  if (r.pass) return "pass";
  return r.pass_basis === "unscored" ? "unscored" : "fail";
}

const OUTCOME_LABEL: Record<Exclude<Outcome, "all">, string> = {
  pass: "Pass",
  fail: "Fail",
  error: "Error",
  unscored: "Unscored",
};

/** Candidate score minus primary score; negative when the candidate trailed. */
const gap = (r: ShadowRecord) => (r.judge ? r.judge.candidate_score - r.judge.primary_score : undefined);

function answerText(a?: Answer): string {
  if (!a) return "";
  const tools = (a.tool_calls ?? []).map((t) => `${t.name}(${t.arguments})`).join("\n");
  return [a.text ?? "", tools].filter(Boolean).join("\n");
}

function useNow(ms = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/**
 * Every comparison the gateway kept, searchable and sortable, opened one
 * request at a time: the primary answer next to each candidate's, with the
 * words that changed highlighted and the judge's verdict.
 */
export function Explorer({ data, summary }: { data: RecordsState; summary?: Summary }) {
  const now = useNow();
  const [candidate, setCandidate] = useState("all");
  const [outcome, setOutcome] = useState<Outcome>("all");
  const [basis, setBasis] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelectedState] = useState<string | undefined>(() => window.location.hash.split("/")[1] || undefined);
  // The open comparison lives in the hash, so it can be linked; replaceState keeps the scroll position.
  const setSelected = (id: string | undefined) => {
    setSelectedState(id);
    window.history.replaceState(null, "", id ? `#comparisons/${id}` : "#comparisons");
  };
  // A link to another comparison while this tab is open.
  useEffect(() => {
    const onHash = () => {
      const [tab, id] = window.location.hash.slice(1).split("/");
      if (tab === "comparisons") setSelectedState(id || undefined);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const candidates = useMemo(() => [...new Set(data.records.map((r) => modelId(r.candidate)))].sort(), [data.records]);
  const bases = useMemo(
    () => [...new Set(data.records.map((r) => r.pass_basis).filter((b): b is PassBasis => Boolean(b)))].sort(),
    [data.records],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = data.records.filter((r) => {
      if (candidate !== "all" && modelId(r.candidate) !== candidate) return false;
      if (outcome !== "all" && outcomeOf(r) !== outcome) return false;
      if (basis !== "all" && r.pass_basis !== basis) return false;
      if (q) {
        const hay = `${r.prompt ?? ""}\n${answerText(r.primary_answer)}\n${answerText(r.candidate_answer)}\n${r.judge?.reason ?? ""}`;
        if (!hay.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    const by: Record<Sort, (a: ShadowRecord, b: ShadowRecord) => number> = {
      newest: (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
      oldest: (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
      gap: (a, b) => (gap(a) ?? 99) - (gap(b) ?? 99) || Date.parse(b.created_at) - Date.parse(a.created_at),
      slowest: (a, b) => b.candidate_latency_ms - a.candidate_latency_ms,
    };
    return list.sort(by[sort]);
  }, [data.records, candidate, outcome, basis, query, sort]);

  // A new filter starts from the top of the list.
  useEffect(() => setShown(PAGE), [candidate, outcome, basis, query, sort]);

  const stats = useMemo(() => {
    const scored = filtered.filter(counts);
    const passes = scored.filter((r) => !r.candidate_error && r.pass).length;
    const ok = filtered.filter((r) => !r.candidate_error);
    const primaryCost = ok.reduce((s, r) => s + r.primary_cost_usd, 0);
    const candidateCost = ok.reduce((s, r) => s + r.candidate_cost_usd, 0);
    return {
      n: filtered.length,
      scored: scored.length,
      agreement: scored.length ? passes / scored.length : undefined,
      lower: scored.length ? wilsonLowerBound(passes, scored.length) : undefined,
      p50Primary: median(ok.map((r) => r.primary_latency_ms)),
      p50Candidate: median(ok.map((r) => r.candidate_latency_ms)),
      cheaper: primaryCost > 0 ? 1 - candidateCost / primaryCost : undefined,
    };
  }, [filtered]);

  const current = selected ? data.records.find((r) => r.id === selected) : undefined;
  const siblings = current ? data.records.filter((r) => r.request_id === current.request_id && r.experiment === current.experiment) : [];

  // j and k step through the list, as in a mail client; Escape closes the open comparison.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key === "Escape") {
        if (selected) setSelected(undefined);
        return;
      }
      if (e.key !== "j" && e.key !== "k") return;
      const i = filtered.findIndex((r) => r.id === selected);
      const next = i < 0 ? 0 : e.key === "j" ? Math.min(filtered.length - 1, i + 1) : Math.max(0, i - 1);
      const r = filtered[next];
      if (!r) return;
      e.preventDefault();
      if (next >= shown) setShown((n) => n + PAGE);
      setSelected(r.id);
      requestAnimationFrame(() => document.getElementById(`x-row-${r.id}`)?.scrollIntoView({ block: "nearest" }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const clear = () => {
    setCandidate("all");
    setOutcome("all");
    setBasis("all");
    setQuery("");
  };
  const filteredOut = candidate !== "all" || outcome !== "all" || basis !== "all" || query.trim() !== "";

  return (
    <section className="wrap lv-section lv-x" aria-labelledby="x-h">
      <div className="lv-head">
        <h1 className="lv-h2" id="x-h">
          Comparisons
        </h1>
        <p className="muted small">
          Every shadowed request this gateway kept: what the primary answered, what each candidate answered, and how the pair was judged.
          {data.total > data.records.length && <> Showing the newest {count(data.records.length)} of {count(data.total)}.</>}
          {summary?.judge_model && (
            <>
              {" "}
              Judge: <span className="model">{summary.judge_model}</span>.
            </>
          )}
        </p>
      </div>

      <form className="lv-x__filters" role="search" onSubmit={(e) => e.preventDefault()}>
        <label className="lv-x__search">
          <span className="sr-only">Search prompts, answers and judge reasons</span>
          <input type="search" placeholder="Search prompts, answers, judge reasons" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label>
          <span>Candidate</span>
          <select value={candidate} onChange={(e) => setCandidate(e.target.value)}>
            <option value="all">All candidates</option>
            {candidates.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Outcome</span>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}>
            <option value="all">Any outcome</option>
            <option value="pass">Pass</option>
            <option value="fail">Fail</option>
            <option value="error">Candidate error</option>
            <option value="unscored">Unscored</option>
          </select>
        </label>
        <label>
          <span>Decided by</span>
          <select value={basis} onChange={(e) => setBasis(e.target.value)}>
            <option value="all">Any signal</option>
            {bases.map((b) => (
              <option key={b} value={b}>
                {BASIS[b] ?? b}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Order</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="gap">Worst judge gap first</option>
            <option value="slowest">Slowest candidate first</option>
          </select>
        </label>
      </form>

      <dl className="lv-x__stats num" aria-live="polite">
        <div>
          <dt>In view</dt>
          <dd>{count(stats.n)}</dd>
        </div>
        <div>
          <dt>Agreement</dt>
          <dd>
            {pct(stats.agreement)} <small>lower bound {pct(stats.lower)}</small>
          </dd>
        </div>
        <div>
          <dt>Latency p50</dt>
          <dd>
            {ms(stats.p50Primary)} <small>primary</small> {ms(stats.p50Candidate)} <small>candidate</small>
          </dd>
        </div>
        <div>
          <dt>Candidate cost</dt>
          <dd>{stats.cheaper === undefined ? "–" : stats.cheaper >= 0 ? `${pct(stats.cheaper)} cheaper` : `${pct(-stats.cheaper)} dearer`}</dd>
        </div>
      </dl>

      <div className="lv-x__body" data-open={Boolean(current)}>
        <div className="lv-x__list">
          {!data.loaded && <p className="lv-empty">Loading comparisons…</p>}
          {data.error && !data.loaded && <p className="lv-error small">{data.error}</p>}
          {data.loaded && filtered.length === 0 && (
            <p className="lv-empty">
              {data.records.length === 0 ? "No comparisons yet. They appear as sampled traffic is replayed and scored." : "Nothing matches these filters."}{" "}
              {filteredOut && (
                <button type="button" className="link lv-x__clear" onClick={clear}>
                  Clear the filters
                </button>
              )}
            </p>
          )}
          <ol className="lv-x__rows">
            {filtered.slice(0, shown).map((r) => {
              const o = outcomeOf(r);
              const g = gap(r);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    id={`x-row-${r.id}`}
                    className="lv-x__row"
                    aria-pressed={r.id === selected}
                    onClick={() => setSelected(r.id)}
                  >
                    <span className="lv-x__outcome" data-outcome={o}>
                      {OUTCOME_LABEL[o]}
                    </span>
                    <span className="lv-x__prompt">{r.prompt || <i className="muted">Prompt not stored</i>}</span>
                    <span className="lv-x__meta small">
                      <span className="model">{r.candidate.model}</span>
                      {r.judge && (
                        <span className="num" title="Judge score, primary vs candidate">
                          {r.judge.primary_score} vs {r.judge.candidate_score}
                          {g !== undefined && g < 0 && <b className="lv-x__gap"> {g}</b>}
                        </span>
                      )}
                      <span className="num muted">{ago(r.created_at, now)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {filtered.length > shown && (
            <button type="button" className="btn btn--ghost btn--small lv-x__more" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, filtered.length - shown)} more of {count(filtered.length - shown)}
            </button>
          )}
        </div>

        <div className="lv-x__detail">
          {current ? (
            <RequestView
              record={current}
              siblings={siblings}
              onClose={() => {
                const id = current.id;
                setSelected(undefined);
                // On narrow screens the list was hidden; put focus back on the row that opened it.
                requestAnimationFrame(() => document.getElementById(`x-row-${id}`)?.focus());
              }}
            />
          ) : (
            <div className="lv-x__hint">
              <p>
                <b>Pick a comparison</b> to see the request the way the gateway saw it: the answer your user got, every candidate&rsquo;s answer
                with the changed words marked, and the judge&rsquo;s scores and reason.
              </p>
              <p className="small muted">
                Try the order &ldquo;worst judge gap first&rdquo; to find where a candidate falls short. Keys: <kbd>j</kbd> and <kbd>k</kbd>{" "}
                step through the list, <kbd>Esc</kbd> closes a comparison.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function AnswerBody({ answer }: { answer?: Answer }) {
  if (!answer) return <p className="muted small">Not stored.</p>;
  return (
    <>
      {answer.text && <p className="lv-x__text">{answer.text}</p>}
      {answer.tool_calls?.map((t, i) => (
        <pre key={i} className="lv-x__tool">
          {t.name}({t.arguments})
        </pre>
      ))}
      {!answer.text && !answer.tool_calls?.length && <p className="muted small">(empty answer)</p>}
    </>
  );
}

function DiffBody({ before, after }: { before?: Answer; after?: Answer }) {
  // Without both answers there is nothing to compare against.
  if (!before || !after) return <AnswerBody answer={after} />;
  const segments = wordDiff(answerText(before), answerText(after));
  if (!segments) return <AnswerBody answer={after} />;
  return (
    <p className="lv-x__text lv-x__diff">
      {segments.map((s, i) =>
        s.kind === "same" ? (
          <span key={i}>{s.text}</span>
        ) : s.kind === "add" ? (
          <ins key={i}>{s.text}</ins>
        ) : (
          <del key={i}>{s.text}</del>
        ),
      )}
    </p>
  );
}

const usd = (v: number) => (v === 0 ? "$0" : v >= 0.01 ? `$${v.toFixed(4)}` : v >= 0.00001 ? `$${v.toFixed(5)}` : "under $0.00001");

/** "Judge" in a list, "judge" mid-sentence; acronyms stay. */
const inSentence = (label: string) => (/^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1));

function RequestView({ record, siblings, onClose }: { record: ShadowRecord; siblings: ShadowRecord[]; onClose: () => void }) {
  const [showDiff, setShowDiff] = useState(true);
  const [copied, setCopied] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  const primary = siblings[0] ?? record;

  // Below the two-column width the list hides when a comparison opens, so focus moves to its back button.
  useEffect(() => {
    if (window.matchMedia("(max-width: 999px)").matches) back.current?.focus();
  }, [record.id]);
  const ordered = [record, ...siblings.filter((s) => s.id !== record.id)];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(siblings.length ? siblings : [record], null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="lv-x__req" aria-label="Selected request">
      <header className="lv-x__req-head">
        <button ref={back} type="button" className="btn btn--ghost btn--small lv-x__back" onClick={onClose}>
          Back to the list
        </button>
        <p className="small muted num">
          Request {record.request_id.slice(0, 8)}, {new Date(record.created_at).toLocaleString()}
          {record.stream && ", streamed"}
        </p>
      </header>

      <div className="lv-x__q">
        <p className="lv-x__label small">Prompt</p>
        <p className="lv-x__prompt-full">{record.prompt || <i className="muted">Not stored on this gateway.</i>}</p>
      </div>

      <section className="lv-x__ans" data-role="primary">
        <p className="lv-x__who">
          <span>
            What the user got from <span className="model">{primary.primary.model}</span>
          </span>
          <span className="small muted num">
            {ms(primary.primary_latency_ms)}, {primary.primary_input_tokens}+{primary.primary_output_tokens} tokens, {usd(primary.primary_cost_usd)}
          </span>
        </p>
        <AnswerBody answer={primary.primary_answer} />
      </section>

      <div className="lv-x__toggles">
        <p className="lv-x__label small">In the shadow, after the answer was sent</p>
        <label className="lv-x__check small">
          <input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} /> Mark the words that differ
        </label>
      </div>

      {ordered.map((r) => {
        const o = outcomeOf(r);
        const c = r.comparison;
        return (
          <section key={r.id} className="lv-x__ans" data-role="candidate" data-outcome={o} data-current={r.id === record.id}>
            <p className="lv-x__who">
              <span>
                <span className="lv-x__outcome" data-outcome={o}>
                  {OUTCOME_LABEL[o]}
                </span>{" "}
                <span className="model">{r.candidate.model}</span>
              </span>
              {!r.candidate_error && (
                <span className="small muted num">
                  {ms(r.candidate_latency_ms)}, {r.candidate_input_tokens}+{r.candidate_output_tokens} tokens, {usd(r.candidate_cost_usd)}
                </span>
              )}
            </p>
            {r.candidate_error ? (
              <p className="lv-error small">The candidate call failed: {r.candidate_error}</p>
            ) : showDiff ? (
              <DiffBody before={r.primary_answer} after={r.candidate_answer} />
            ) : (
              <AnswerBody answer={r.candidate_answer} />
            )}
            {r.judge && (
              <div className="lv-x__judge">
                <p className="num">
                  <b>{r.judge.primary_score}</b> <span className="muted">primary</span> <b>{r.judge.candidate_score}</b>{" "}
                  <span className="muted">candidate</span>
                </p>
                {r.judge.reason && <p>&ldquo;{r.judge.reason}&rdquo;</p>}
                <p className="small muted">
                  Judge saw the candidate {r.judge.candidate_shown_first ? "first" : "second"}. Decided by {inSentence(BASIS[r.pass_basis ?? "unscored"] ?? r.pass_basis ?? "")}.
                </p>
              </div>
            )}
            {r.judge_error && <p className="lv-error small">The judge call failed: {r.judge_error}</p>}
            {c && (
              <p className="small muted num lv-x__signals">
                Lexical {pct(c.lexical_similarity, 0)}
                {c.semantic_similarity !== undefined && <>, semantic {pct(c.semantic_similarity, 0)}</>}, length ratio {c.length_ratio.toFixed(2)}
                {c.exact_match && ", exact match"}
                {c.tool_call_diff && <>, tool calls: {c.tool_call_diff.replace("_", " ")}</>}
                {c.json_match === false && ", JSON shape differs"}
                {!c.finish_reason_match && ", different finish reason"}
              </p>
            )}
          </section>
        );
      })}

      <p className="lv-x__foot">
        <button type="button" className="btn btn--ghost btn--small" onClick={copy}>
          {copied ? "Copied" : "Copy as JSON"}
        </button>
      </p>
    </article>
  );
}
