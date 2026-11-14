import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconClose, IconCopy } from "../components/Icons";
import { wilsonLowerBound } from "../lib/stats";
import { count, errorText, pct, saveBlob, useConnection } from "./backend";
import {
  check,
  commands,
  DEFAULTS,
  defaultDraft,
  dollars,
  draftFromSummary,
  EMBEDDING_HINTS,
  estimate,
  experimentName,
  formatJSON,
  fullConfig,
  keyVariable,
  MODEL_HINTS,
  modelKey,
  newCandidate,
  num,
  pluginEntry,
  providerDocs,
  providerNotes,
  PROVIDERS,
  reviveDraft,
  type CandidateDraft,
  type Detail,
  type Draft,
  type Effort,
  type ModelDraft,
  type RunAuth,
} from "./configBuilder";
import { comparisonsToClear, type RecordsState } from "./records";
import type { ShadowRecord, Summary } from "./shadowClient";
import "./setup.css";

type Format = "entry" | "full" | "api";

const FORMATS: { id: Format; label: string; file: string; name: string; type: string }[] = [
  { id: "entry", label: "Plugin only", file: "The plugins list of config.json", name: "shadow-plugin.json", type: "application/json" },
  { id: "full", label: "Whole config.json", file: "config.json, a key per provider read from the environment", name: "config.json", type: "application/json" },
  { id: "api", label: "API call", file: "Shell, for a gateway that is already running", name: "add-shadow-plugin.sh", type: "text/x-shellscript" },
];

const SAVED = "relayproof.setup";

interface Saved {
  draft: Draft;
  format: Format;
  detail: Detail;
  gateway: string;
  auth: RunAuth;
}

function load(): Partial<Saved> & { draft: Draft } {
  try {
    const s = JSON.parse(localStorage.getItem(SAVED) ?? "null") as Partial<Record<keyof Saved, unknown>> | null;
    if (s) {
      return {
        draft: reviveDraft(s.draft) ?? defaultDraft(),
        format: FORMATS.some((f) => f.id === s.format) ? (s.format as Format) : undefined,
        detail: s.detail === "all" ? "all" : "changes",
        gateway: typeof s.gateway === "string" ? s.gateway : undefined,
        auth: s.auth === "login" || s.auth === "none" || s.auth === "token" ? s.auth : undefined,
      };
    }
  } catch {
    // Storage blocked or corrupt: start from the defaults.
  }
  return { draft: defaultDraft() };
}

function save(s: Saved) {
  try {
    localStorage.setItem(SAVED, JSON.stringify(s));
  } catch {
    // Not remembering the form is fine.
  }
}

/** One id per field, for the label, the error and the jump from the issue list. */
const fieldId = (f: string) => `su-${f.replace(/[^a-z0-9]+/gi, "-")}`;

const LABELS: Record<string, string> = {
  name: "Experiment name",
  "source.provider": "Source provider",
  "source.model": "Source model",
  candidates: "Candidates",
  sampleRate: "Sample rate",
  "judge.provider": "Judge provider",
  "judge.model": "Judge model",
  judgeSampleRate: "Share of pairs judged",
  judgeMaxTokens: "Judge reply limit",
  qualityTolerance: "Quality tolerance",
  maxJudgeErrorRate: "Judge error limit",
  "embedding.provider": "Embedding provider",
  "embedding.model": "Embedding model",
  semanticThreshold: "Embedding similarity needed",
  lexicalThreshold: "Word overlap needed",
  minSamples: "Minimum comparisons",
  minAgreement: "Minimum agreement",
  maxErrorRate: "Maximum error rate",
  dailyBudget: "Daily budget",
  maxPayloadChars: "Characters kept",
  maxConcurrency: "Workers",
  queueSize: "Queue size",
  timeoutSeconds: "Timeout",
  persistPath: "Records file",
  maxRecords: "Comparisons in memory",
  canaryMinRequests: "Requests before judging health",
  canaryMaxErrorRate: "Live error limit",
  canaryMaxLatencyRatio: "Latency limit",
  requestsPerDay: "Requests a day",
  judgeCost: "Judge call cost",
  embeddingCost: "Embedding call cost",
};

function labelOf(f: string, candidates: CandidateDraft[]): string {
  const m = /^cand\.([^.]+)\.(provider|model|cost)$/.exec(f);
  if (m) {
    const i = candidates.findIndex((c) => c.key === m[1]);
    return `Candidate ${i + 1} ${m[2] === "cost" ? "call cost" : m[2]}`;
  }
  return LABELS[f] ?? f;
}

/** Moves focus to a field, opening the disclosure it may sit in. */
function focusField(f: string) {
  const el = document.getElementById(fieldId(f));
  if (!el) return;
  const details = el.closest("details");
  if (details && !details.open) details.open = true;
  el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  el.focus({ preventScroll: true });
}

/**
 * Set up: a guided builder for the plugin's config. Every choice is checked
 * against the rules the plugin applies when it loads, the JSON beside the form
 * follows each change, and the steps below it say how to build, start and check
 * a gateway with it. Nothing on this page is sent anywhere.
 */
export function Setup({ data, summary }: { data: RecordsState; summary?: Summary }) {
  const conn = useConnection();
  const [initial] = useState(load);
  const [draft, setDraftState] = useState<Draft>(initial.draft);
  const [format, setFormat] = useState<Format>(initial.format ?? "entry");
  const [detail, setDetail] = useState<Detail>(initial.detail ?? "changes");
  const [gateway, setGateway] = useState(initial.gateway ?? (conn.mode === "gateway" ? conn.base : "http://localhost:8080"));
  const [auth, setAuth] = useState<RunAuth>(initial.auth ?? "token");
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const [measured, setMeasured] = useState<Set<string>>(() => new Set());
  const [undo, setUndo] = useState<{ draft: Draft; text: string; started?: boolean }>();
  const [experiment, setExperiment] = useState(0);
  const [prefilling, setPrefilling] = useState(false);
  const [prefillError, setPrefillError] = useState<string>();
  // Characters that fit across the config's code panel, so the JSON wraps to it.
  const [cols, setCols] = useState(72);
  const focusNext = useRef<string>(undefined);
  const addRef = useRef<HTMLButtonElement>(null);
  const origin = window.location.origin;

  useEffect(() => save({ draft, format, detail, gateway, auth }), [draft, format, detail, gateway, auth]);

  // After adding a candidate, focus its model field.
  useEffect(() => {
    if (!focusNext.current) return;
    document.getElementById(fieldId(focusNext.current))?.focus();
    focusNext.current = undefined;
  });

  const result = useMemo(() => check(draft), [draft]);
  const spend = useMemo(() => estimate(draft), [draft]);
  const issues = Object.entries(result.errors).filter((e): e is [string, string] => Boolean(e[1]));
  const err = (f: string) => (touched.has(f) ? (result.errors[f] ?? spend.errors[f]) : undefined);
  const touch = (f: string) => setTouched((t) => (t.has(f) ? t : new Set(t).add(f)));

  const setDraft = (update: (d: Draft) => Draft, fields: string[] = []) => {
    setDraftState(update);
    if (fields.some((f) => measured.has(f))) setMeasured((m) => new Set([...m].filter((f) => !fields.includes(f))));
  };
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }), [key]);
  const setModel = (key: "source" | "judge" | "embedding", patch: Partial<ModelDraft>) =>
    setDraft((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  const setCandidate = (key: string, patch: Partial<CandidateDraft>) =>
    setDraft((d) => ({ ...d, candidates: d.candidates.map((c) => (c.key === key ? { ...c, ...patch } : c)) }), [`cand.${key}.cost`]);

  const addCandidate = () => {
    const c = newCandidate(draft.source.provider.trim());
    focusNext.current = c.provider ? `cand.${c.key}.model` : `cand.${c.key}.provider`;
    setDraft((d) => ({ ...d, candidates: [...d.candidates, c] }));
  };
  const removeCandidate = (key: string) => {
    setDraft((d) => ({ ...d, candidates: d.candidates.filter((c) => c.key !== key) }));
    addRef.current?.focus();
  };

  /** Props every input gets: its id, what describes it, and touch on blur. */
  const aria: Aria = (f, hint) => {
    const e = err(f);
    const id = fieldId(f);
    const by = [e && `${id}-err`, hint && `${id}-hint`].filter(Boolean).join(" ");
    return { id, "aria-invalid": e ? true : undefined, "aria-describedby": by || undefined, onBlur: () => touch(f) };
  };

  const startFrom = async () => {
    if (!summary) return;
    setPrefilling(true);
    setPrefillError(undefined);
    // Judge costs come from comparisons. This tab does not load them, so fetch a page if none are at hand.
    let records: ShadowRecord[] = data.records;
    if (records.length === 0) {
      try {
        records = (await conn.client.records({ limit: 200 })).records;
      } catch (e) {
        setPrefillError(`Comparisons did not load (${errorText(e)}), so the judge's cost keeps its value.`);
      }
    }
    const next = draftFromSummary(draft, summary, experiment, records, Date.now());
    setUndo({ draft, text: `Started from ${conn.mode === "trial" ? "the demo" : conn.label}'s settings.`, started: true });
    setDraftState(next.draft);
    setMeasured(new Set(next.measured));
    setTouched(new Set());
    setPrefilling(false);
  };
  const reset = () => {
    setUndo({ draft, text: "Back to the defaults." });
    setDraftState(defaultDraft());
    setMeasured(new Set());
    setTouched(new Set());
  };

  const fmt = FORMATS.find((f) => f.id === format) ?? FORMATS[0];
  const cmds = useMemo(() => commands(draft, { gateway, auth, origin }, detail), [draft, gateway, auth, origin, detail]);
  const code = useMemo(() => {
    if (format === "entry") return formatJSON({ plugins: [pluginEntry(draft, detail)] }, cols);
    if (format === "full") return formatJSON(fullConfig(draft, detail, origin), cols);
    return cmds.apply;
  }, [format, draft, detail, origin, cmds.apply, cols]);
  const blocked = issues.length > 0;
  const notes = providerNotes(draft);

  const rate = num(draft.sampleRate);
  const minAgreement = num(draft.minAgreement);
  const minSamples = num(draft.minSamples);

  return (
    <section className="wrap lv-section su" aria-labelledby="setup-h">
      <ModelLists />
      <div className="lv-head">
        <h1 className="lv-h2" id="setup-h">
          Set up on your gateway
        </h1>
        <p className="muted small">
          Choose the models to compare and how strict the gate is. This page writes the plugin&rsquo;s config for Bifrost, checks it
          against the rules the plugin applies when it loads, and lists the commands to build, start and check a gateway with it.
          Nothing you enter leaves this page.
        </p>
      </div>

      <div className="su-from">
        <div aria-live="polite">
          {undo ? (
            <p className="small">
              {undo.text}{" "}
              {undo.started && (
                <span className="muted">
                  The summary does not report judge tokens, queue sizes, the allow-list or payload storage, so those kept their values.
                </span>
              )}
            </p>
          ) : summary ? (
            <p className="small">
              {conn.mode === "trial" ? "The hosted demo" : <b className="model">{conn.label}</b>} runs{" "}
              {summary.experiments.length === 1 ? (
                <>
                  <b>{summary.experiments[0].name}</b>:{" "}
                  <span className="model">{modelKey({ provider: summary.experiments[0].source.provider ?? "", model: summary.experiments[0].source.model })}</span>{" "}
                  against {summary.experiments[0].candidates.length} candidate{summary.experiments[0].candidates.length === 1 ? "" : "s"}
                </>
              ) : (
                <>{summary.experiments.length} experiments</>
              )}
              {summary.judge_model ? (
                <>
                  , judged by <span className="model">{summary.judge_model}</span>.
                </>
              ) : (
                ", with no judge."
              )}{" "}
              <span className="muted">Its settings can be your starting point.</span>
            </p>
          ) : (
            <p className="small muted">
              {conn.mode === "trial" ? "Waiting for the demo gateway." : `Waiting for ${conn.label}.`} Its settings can be your starting point
              once it answers.
            </p>
          )}
          {prefillError && <p className="small lv-error">{prefillError}</p>}
        </div>
        <div className="su-from__actions">
          {summary && summary.experiments.length > 1 && (
            <select aria-label="Experiment to start from" value={experiment} onChange={(e) => setExperiment(Number(e.target.value))}>
              {summary.experiments.map((x, i) => (
                <option key={x.name} value={i}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
          {summary && summary.experiments.length > 0 && (
            <button type="button" className="btn btn--small" onClick={startFrom} disabled={prefilling}>
              {prefilling ? "Reading settings…" : conn.mode === "trial" ? "Start from the demo's settings" : "Start from this gateway's settings"}
            </button>
          )}
          {undo && (
            <button
              type="button"
              className="btn btn--ghost btn--small"
              onClick={() => {
                setDraftState(undo.draft);
                setMeasured(new Set());
                setUndo(undefined);
              }}
            >
              Undo
            </button>
          )}
          <button type="button" className="link small" onClick={reset}>
            Reset to defaults
          </button>
        </div>
      </div>

      <p className="su-skip small">
        {/* Not a hash link: the hash names the console's tab. */}
        <button
          type="button"
          className="link"
          onClick={() => {
            const out = document.getElementById("su-out");
            out?.scrollIntoView({ block: "start" });
            out?.focus({ preventScroll: true });
          }}
        >
          Jump to the config
        </button>
      </p>

      <div className="su-grid">
        <form className="su-form" onSubmit={(e) => e.preventDefault()} noValidate aria-label="Plugin settings">
          {/* 1. Experiment */}
          <Step n={1} id="su-s-exp" title="Experiment" lede="Which live requests to copy, and which models answer the copies in the shadow.">
            <Field f="name" label="Name" error={err("name")} hint={<>Shown in reports and used in promote calls. Empty uses &ldquo;{experimentName({ ...draft, name: "" })}&rdquo;.</>}>
              <input type="text" autoComplete="off" spellCheck={false} value={draft.name} placeholder="e.g. Opus cost-down" onChange={(e) => set("name", e.target.value)} {...aria("name", true)} />
            </Field>

            <fieldset className="su-group">
              <legend>Source model</legend>
              <p className="su-hint">The model your application calls today. Its live answers are what the candidates are compared with.</p>
              <ModelPair
                base="source"
                value={draft.source}
                onChange={(p) => setModel("source", p)}
                err={err}
                aria={aria}
                providerHint="Empty matches any provider."
                modelHint="* matches every model."
              />
            </fieldset>

            <div className="su-cands">
              {draft.candidates.map((c, i) => (
                <fieldset key={c.key} className="su-group su-cand">
                  <legend>Candidate {i + 1}</legend>
                  <ModelPair base={`cand.${c.key}`} value={c} onChange={(p) => setCandidate(c.key, p)} err={err} aria={aria} />
                  <button
                    type="button"
                    className="su-remove"
                    onClick={() => removeCandidate(c.key)}
                    aria-label={`Remove candidate ${i + 1}${modelKey(c) ? `, ${modelKey(c)}` : ""}`}
                    title="Remove"
                  >
                    <IconClose />
                  </button>
                </fieldset>
              ))}
              {result.errors.candidates && (
                <p className="su-err" id={fieldId("candidates")} tabIndex={-1}>
                  {result.errors.candidates}
                </p>
              )}
              <button ref={addRef} type="button" className="btn btn--ghost btn--small su-add" onClick={addCandidate}>
                Add a candidate
              </button>
            </div>

            <Field
              f="sampleRate"
              label="Sample rate"
              error={err("sampleRate")}
              hint={
                rate !== undefined && rate > 0 && rate <= 1
                  ? rate === 1
                    ? "Every matching request is copied, to every candidate."
                    : rate <= 0.5
                      ? `About one matching request in ${count(Math.round(1 / rate))} is copied, to every candidate.`
                      : `${pct(rate, 0)} of matching requests are copied, to every candidate.`
                  : "A share from 0 to 1 of matching requests."
              }
              narrow
            >
              <input type="text" inputMode="decimal" autoComplete="off" value={draft.sampleRate} onChange={(e) => set("sampleRate", e.target.value)} {...aria("sampleRate", true)} />
            </Field>
          </Step>

          {/* 2. Evaluation */}
          <Step n={2} id="su-s-eval" title="Evaluation" lede="How each pair of answers is scored. Two checks always run first: a candidate that calls a different tool, or breaks the JSON shape the primary returned, fails.">
            <Switch
              checked={draft.judgeOn}
              onChange={(v) => set("judgeOn", v)}
              label="Score each pair with an LLM judge"
              note="The judge reads both answers in a random order and scores each out of 10. It is the strongest signal for free-text answers."
            />
            {draft.judgeOn ? (
              <div className="su-sub">
                <ModelPair base="judge" value={draft.judge} onChange={(p) => setModel("judge", p)} err={err} aria={aria} />
                <div className="su-fields su-fields--2">
                  <Field f="judgeSampleRate" label="Share of pairs judged" error={err("judgeSampleRate")} hint="1 judges every pair.">
                    <input type="text" inputMode="decimal" autoComplete="off" value={draft.judgeSampleRate} onChange={(e) => set("judgeSampleRate", e.target.value)} {...aria("judgeSampleRate", true)} />
                  </Field>
                  <Field
                    f="qualityTolerance"
                    label="Quality tolerance"
                    error={err("qualityTolerance")}
                    hint="Judge points the candidate may trail by and still pass. 0 passes only answers scored as high."
                  >
                    <input type="text" inputMode="decimal" autoComplete="off" value={draft.qualityTolerance} onChange={(e) => set("qualityTolerance", e.target.value)} {...aria("qualityTolerance", true)} />
                  </Field>
                  <Field
                    f="judgeMaxTokens"
                    label="Judge reply limit, tokens"
                    error={err("judgeMaxTokens")}
                    hint={`Default ${DEFAULTS.judgeMaxTokens}. Models that think first count thinking against it: the hosted demo gives Opus 2048 at low effort.`}
                  >
                    <input type="text" inputMode="numeric" autoComplete="off" value={draft.judgeMaxTokens} onChange={(e) => set("judgeMaxTokens", e.target.value)} {...aria("judgeMaxTokens", true)} />
                  </Field>
                  <div className="su-field">
                    <label htmlFor="su-judgeEffort">Reasoning effort</label>
                    <select id="su-judgeEffort" value={draft.judgeEffort} onChange={(e) => set("judgeEffort", e.target.value as Effort)} aria-describedby="su-judgeEffort-hint">
                      <option value="">The model&rsquo;s default</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                    <p className="su-hint" id="su-judgeEffort-hint">
                      Sent as the judge request&rsquo;s reasoning effort.
                    </p>
                  </div>
                  <Field
                    f="maxJudgeErrorRate"
                    label="Judge error limit"
                    error={err("maxJudgeErrorRate")}
                    hint="Share of judge calls that may fail before verdicts are withheld: a failing judge cannot vouch for anything."
                  >
                    <input type="text" inputMode="decimal" autoComplete="off" value={draft.maxJudgeErrorRate} onChange={(e) => set("maxJudgeErrorRate", e.target.value)} {...aria("maxJudgeErrorRate", true)} />
                  </Field>
                </div>
              </div>
            ) : (
              <p className="su-note small">
                Without a judge, a pair is decided by an exact match first, then by embeddings if they are on, then by word overlap only if you
                choose it below. A pair none of these can decide is <b>unscored</b>: it counts toward neither agreement nor the minimum, so
                free-text traffic may never reach a verdict.
              </p>
            )}

            <Switch
              checked={draft.embeddingOn}
              onChange={(v) => set("embeddingOn", v)}
              label="Compare meaning with embeddings"
              note="Cosine similarity of the two answers decides a pair the judge did not. Cheap, but it cannot tell a right number from a wrong one."
            />
            {draft.embeddingOn && (
              <div className="su-sub">
                <ModelPair base="embedding" value={draft.embedding} onChange={(p) => setModel("embedding", p)} err={err} aria={aria} embedding />
                <Field f="semanticThreshold" label="Similarity needed to pass" error={err("semanticThreshold")} hint={`From 0 to 1; default ${DEFAULTS.semanticThreshold}.`} narrow>
                  <input type="text" inputMode="decimal" autoComplete="off" value={draft.semanticThreshold} onChange={(e) => set("semanticThreshold", e.target.value)} {...aria("semanticThreshold", true)} />
                </Field>
              </div>
            )}

            <fieldset className="su-choice">
              <legend>When nothing stronger decides a pair</legend>
              <div className="su-choice__opts">
              <label data-on={draft.qualityFallback === "none"}>
                <input type="radio" name="su-fallback" checked={draft.qualityFallback === "none"} onChange={() => set("qualityFallback", "none")} />
                <span>
                  <b>Leave it unscored</b>
                  <span>The default. The pair waits for better evidence instead of passing on weak evidence.</span>
                </span>
              </label>
              <label data-on={draft.qualityFallback === "lexical"}>
                <input type="radio" name="su-fallback" checked={draft.qualityFallback === "lexical"} onChange={() => set("qualityFallback", "lexical")} />
                <span>
                  <b>Score it by word overlap</b>
                  <span>For setups with no judge or embeddings. Overlap does not check meaning.</span>
                </span>
              </label>
              </div>
            </fieldset>
            {draft.qualityFallback === "lexical" && (
              <Field f="lexicalThreshold" label="Word overlap needed to pass" error={err("lexicalThreshold")} hint={`Token F1 from 0 to 1; default ${DEFAULTS.lexicalThreshold}.`} narrow>
                <input type="text" inputMode="decimal" autoComplete="off" value={draft.lexicalThreshold} onChange={(e) => set("lexicalThreshold", e.target.value)} {...aria("lexicalThreshold", true)} />
              </Field>
            )}
          </Step>

          {/* 3. Readiness gate */}
          <Step n={3} id="su-s-gate" title="Readiness gate" lede="When a candidate counts as Ready, the only verdict that promotes without an override.">
            <div className="su-fields su-fields--3">
              <Field f="minSamples" label="Minimum comparisons" error={err("minSamples")} hint={`Scored, before any verdict. Default ${DEFAULTS.minSamples}.`}>
                <input type="text" inputMode="numeric" autoComplete="off" value={draft.minSamples} onChange={(e) => set("minSamples", e.target.value)} {...aria("minSamples", true)} />
              </Field>
              <Field f="minAgreement" label="Minimum agreement" error={err("minAgreement")} hint={`The 95% lower bound must reach it. Default ${DEFAULTS.minAgreement}.`}>
                <input type="text" inputMode="decimal" autoComplete="off" value={draft.minAgreement} onChange={(e) => set("minAgreement", e.target.value)} {...aria("minAgreement", true)} />
              </Field>
              <Field f="maxErrorRate" label="Maximum error rate" error={err("maxErrorRate")} hint={`Share of candidate calls that may fail. Default ${DEFAULTS.maxErrorRate}.`}>
                <input type="text" inputMode="decimal" autoComplete="off" value={draft.maxErrorRate} onChange={(e) => set("maxErrorRate", e.target.value)} {...aria("maxErrorRate", true)} />
              </Field>
            </div>
            <GateNote minSamples={minSamples} minAgreement={minAgreement} />
          </Step>

          {/* 4. Safety and spend */}
          <Step n={4} id="su-s-safety" title="Safety and spend" lede="Limits that keep shadow work cheap and out of the way of live traffic.">
            <Field
              f="dailyBudget"
              label="Daily budget, US dollars"
              error={err("dailyBudget")}
              hint="Caps shadow, judge and embedding spend per UTC day; sampling pauses once it is reached. 0 means no cap."
              narrow
            >
              <input type="text" inputMode="decimal" autoComplete="off" value={draft.dailyBudget} onChange={(e) => set("dailyBudget", e.target.value)} {...aria("dailyBudget", true)} />
            </Field>

            <SpendPanel draft={draft} spend={spend} err={err} aria={aria} set={set} setCandidate={setCandidate} measured={measured} />

            <Field
              f="virtualKeys"
              label="Only mirror these virtual keys"
              error={err("virtualKeys")}
              hint="IDs, names or values, one per line or separated by commas. Empty mirrors requests from every key."
            >
              <textarea rows={2} spellCheck={false} value={draft.virtualKeys} placeholder="e.g. team-search" onChange={(e) => set("virtualKeys", e.target.value)} {...aria("virtualKeys", true)} />
            </Field>

            <Switch
              checked={draft.storePayloads}
              onChange={(v) => set("storePayloads", v)}
              label="Keep prompts and answers"
              note="For side-by-side review on the Comparisons tab. Off keeps only scores, for sensitive traffic."
            />
            {draft.storePayloads && (
              <div className="su-sub">
                <Field f="maxPayloadChars" label="Characters kept per prompt or answer" error={err("maxPayloadChars")} hint={`Longer text is cut. Default ${count(DEFAULTS.maxPayloadChars)}.`} narrow>
                  <input type="text" inputMode="numeric" autoComplete="off" value={draft.maxPayloadChars} onChange={(e) => set("maxPayloadChars", e.target.value)} {...aria("maxPayloadChars", true)} />
                </Field>
              </div>
            )}

            <Switch
              checked={draft.allowForceHeader}
              onChange={(v) => set("allowForceHeader", v)}
              label={
                <>
                  Allow the <code>x-bf-shadow: force</code> header
                </>
              }
              note={
                <>
                  Lets a caller mirror a request that was not sampled. Shadow calls skip governance, so allow it only where callers are trusted,
                  such as tests and demos. <code>x-bf-shadow: off</code> always works.
                </>
              }
            />

            <Switch
              checked={draft.persist}
              onChange={(v) => set("persist", v)}
              label="Keep records on disk"
              note="Appends every comparison to a JSONL file and reloads it on start. Today's spend and the rollout log survive restarts with it."
            />
            {draft.persist && (
              <div className="su-sub">
                <Field f="persistPath" label="Records file" error={err("persistPath")} hint="Relative to the gateway's app directory.">
                  <input type="text" autoComplete="off" spellCheck={false} value={draft.persistPath} onChange={(e) => set("persistPath", e.target.value)} {...aria("persistPath", true)} />
                </Field>
              </div>
            )}

            <details className="su-more">
              <summary>Workers, queue and memory</summary>
              <div className="su-fields su-fields--2">
                <Field f="maxConcurrency" label="Workers" error={err("maxConcurrency")} hint={`Shadow calls at once. Default ${DEFAULTS.maxConcurrency}.`}>
                  <input type="text" inputMode="numeric" autoComplete="off" value={draft.maxConcurrency} onChange={(e) => set("maxConcurrency", e.target.value)} {...aria("maxConcurrency", true)} />
                </Field>
                <Field f="queueSize" label="Queue size" error={err("queueSize")} hint={`Pending jobs. A full queue drops new ones and never slows live traffic. Default ${DEFAULTS.queueSize}.`}>
                  <input type="text" inputMode="numeric" autoComplete="off" value={draft.queueSize} onChange={(e) => set("queueSize", e.target.value)} {...aria("queueSize", true)} />
                </Field>
                <Field f="timeoutSeconds" label="Timeout, seconds" error={err("timeoutSeconds")} hint={`For each candidate, judge and embedding call. Default ${DEFAULTS.timeoutSeconds}.`}>
                  <input type="text" inputMode="numeric" autoComplete="off" value={draft.timeoutSeconds} onChange={(e) => set("timeoutSeconds", e.target.value)} {...aria("timeoutSeconds", true)} />
                </Field>
                <Field f="maxRecords" label="Comparisons in memory" error={err("maxRecords")} hint={`The oldest go first. Default ${count(DEFAULTS.maxRecords)}.`}>
                  <input type="text" inputMode="numeric" autoComplete="off" value={draft.maxRecords} onChange={(e) => set("maxRecords", e.target.value)} {...aria("maxRecords", true)} />
                </Field>
              </div>
            </details>
          </Step>

          {/* 5. Canary guard */}
          <Step n={5} id="su-s-canary" title="Canary guard" lede="After a promotion, the guard compares the candidate's live error rate and latency with the source's on the same traffic.">
            <Switch
              checked={draft.canaryAutoRollback}
              onChange={(v) => set("canaryAutoRollback", v)}
              label="Roll an unhealthy canary back on its own"
              note="Within a few seconds of a breach, with the evidence logged. Off, the guard only reports health on the Rollout tab and you decide."
            />
            <div className="su-fields su-fields--3">
              <Field f="canaryMinRequests" label="Requests before judging" error={err("canaryMinRequests")} hint={`Live candidate requests. Default ${DEFAULTS.canaryMinRequests}.`}>
                <input type="text" inputMode="numeric" autoComplete="off" value={draft.canaryMinRequests} onChange={(e) => set("canaryMinRequests", e.target.value)} {...aria("canaryMinRequests", true)} />
              </Field>
              <Field
                f="canaryMaxErrorRate"
                label="Live error limit"
                error={err("canaryMaxErrorRate")}
                hint={<>As a 95% lower bound. Empty uses the gate&rsquo;s {draft.maxErrorRate.trim() || DEFAULTS.maxErrorRate}.</>}
              >
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft.canaryMaxErrorRate}
                  placeholder={draft.maxErrorRate.trim() || String(DEFAULTS.maxErrorRate)}
                  onChange={(e) => set("canaryMaxErrorRate", e.target.value)}
                  {...aria("canaryMaxErrorRate", true)}
                />
              </Field>
              <Field f="canaryMaxLatencyRatio" label="Latency limit" error={err("canaryMaxLatencyRatio")} hint="Candidate p95 as a multiple of the source's. 0 is off.">
                <input type="text" inputMode="decimal" autoComplete="off" value={draft.canaryMaxLatencyRatio} onChange={(e) => set("canaryMaxLatencyRatio", e.target.value)} {...aria("canaryMaxLatencyRatio", true)} />
              </Field>
            </div>
            <Switch
              checked={draft.canaryRollbackOnNotReady}
              onChange={(v) => set("canaryRollbackOnNotReady", v)}
              label="Also roll back when the verdict turns Not ready"
              note="The experiment keeps running after a promotion, so the scorecard stays current."
            />
          </Step>
        </form>

        <aside className="su-out" id="su-out" aria-labelledby="su-out-h" tabIndex={-1}>
          <div className="su-out__head">
            <h2 className="su-out__title" id="su-out-h">
              Your config
            </h2>
            <fieldset className="su-seg">
              <legend className="sr-only">Format</legend>
              {FORMATS.map((f) => (
                <label key={f.id} data-on={format === f.id}>
                  <input type="radio" name="su-format" checked={format === f.id} onChange={() => setFormat(f.id)} />
                  {f.label}
                </label>
              ))}
            </fieldset>
          </div>
          <div className="su-out__opts">
            <p className="small muted">{fmt.file}</p>
            <label className="su-check small">
              <input type="checkbox" checked={detail === "all"} onChange={(e) => setDetail(e.target.checked ? "all" : "changes")} />
              Write every setting
            </label>
          </div>

          <CodeBlock code={code} kind={format === "api" ? "shell" : "json"} label={`${fmt.label} for the shadow plugin`} big onColumns={setCols} />

          <div className="su-out__actions">
            <CopyButton text={code} disabled={blocked} label="Copy" />
            <button type="button" className="btn btn--ghost btn--small" disabled={blocked} onClick={() => saveBlob(new Blob([`${code}\n`], { type: fmt.type }), fmt.name)}>
              Download {fmt.name}
            </button>
          </div>

          <div className="su-out__status" aria-live="polite">
            {blocked ? (
              <div className="su-issues" role="group" aria-label="Fields to fix">
                <p className="small">
                  <b>
                    {issues.length} {issues.length === 1 ? "field needs" : "fields need"} a fix
                  </b>{" "}
                  before the plugin would load this:
                </p>
                <ul>
                  {issues.map(([f, message]) => (
                    <li key={f}>
                      <button
                        type="button"
                        className="link small"
                        onClick={() => {
                          touch(f);
                          focusField(f);
                        }}
                      >
                        {labelOf(f, draft.candidates)}
                      </button>
                      <span className="small muted"> {message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="su-ok small">
                <IconCheck /> Passes the checks the plugin runs when it loads: field names, nesting, ranges.
              </p>
            )}
            {result.warnings.length > 0 && (
              <ul className="su-warns">
                {result.warnings.map((w) => (
                  <li key={w} className="small">
                    {w}
                  </li>
                ))}
              </ul>
            )}
            {notes.length > 0 && (
              <p className="small muted su-providers">
                Every provider named here needs to be set up in the gateway:{" "}
                {notes.map((n, i) => (
                  <span key={n.provider}>
                    {i > 0 && ", "}
                    {n.note ? (
                      <a className="link" href={providerDocs(n.provider)} target="_blank" rel="noreferrer">
                        {n.provider}
                      </a>
                    ) : (
                      <span className="model">{n.provider}</span>
                    )}
                    {n.note === "self-hosted" && " (its server's URL)"}
                    {n.note === "rich-key" && " (more than a key)"}
                  </span>
                ))}
                .
                {format === "full" && notes.some((n) => n.note !== "self-hosted") && (
                  <>
                    {" "}
                    Keys are read from{" "}
                    {notes
                      .filter((n) => n.note !== "self-hosted")
                      .map((n) => keyVariable(n.provider))
                      .join(", ")}
                    .
                  </>
                )}
              </p>
            )}
          </div>
        </aside>
      </div>

      <RunSteps
        draft={draft}
        cmds={cmds}
        gateway={gateway}
        setGateway={setGateway}
        auth={auth}
        setAuth={setAuth}
        origin={origin}
        blocked={blocked}
        downloadFull={() => saveBlob(new Blob([`${formatJSON(fullConfig(draft, detail, origin))}\n`], { type: "application/json" }), "config.json")}
      />
    </section>
  );
}

/* Pieces */

interface AriaProps {
  id: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  onBlur: () => void;
}
type Aria = (f: string, hint?: boolean) => AriaProps;

function Step({ n, id, title, lede, children }: { n: number; id: string; title: string; lede: string; children: ReactNode }) {
  return (
    <section className="su-step" aria-labelledby={id}>
      <header className="su-step__head">
        <span className="su-step__n num" aria-hidden="true">
          {n}
        </span>
        <h2 className="su-step__title" id={id}>
          {title}
        </h2>
        <p className="su-step__lede small">{lede}</p>
      </header>
      {children}
    </section>
  );
}

function Field({
  f,
  label,
  hint,
  error,
  narrow,
  children,
}: {
  f: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  narrow?: boolean;
  children: ReactNode;
}) {
  const id = fieldId(f);
  return (
    <div className="su-field" data-invalid={error ? true : undefined} data-narrow={narrow || undefined}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error && (
        <p className="su-err" id={`${id}-err`}>
          {error}
        </p>
      )}
      {hint && (
        <p className="su-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

function Switch({ checked, onChange, label, note }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; note?: ReactNode }) {
  return (
    <label className="su-switch">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="su-switch__text">
        <b>{label}</b>
        {note && <span className="small muted">{note}</span>}
      </span>
    </label>
  );
}

/** Suggestions for provider and model fields; anything else can be typed. */
function ModelLists() {
  return (
    <>
      <datalist id="su-providers">
        {PROVIDERS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      {Object.entries(MODEL_HINTS).map(([p, models]) => (
        <datalist key={p} id={`su-models-${p}`}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      ))}
      {Object.entries(EMBEDDING_HINTS).map(([p, models]) => (
        <datalist key={p} id={`su-embed-${p}`}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      ))}
    </>
  );
}

function ModelPair({
  base,
  value,
  onChange,
  err,
  aria,
  providerHint,
  modelHint,
  embedding,
}: {
  base: string;
  value: ModelDraft;
  onChange: (patch: Partial<ModelDraft>) => void;
  err: (f: string) => string | undefined;
  aria: Aria;
  providerHint?: string;
  modelHint?: string;
  embedding?: boolean;
}) {
  const provider = value.provider.trim();
  const list = embedding ? (EMBEDDING_HINTS[provider] ? `su-embed-${provider}` : undefined) : MODEL_HINTS[provider] ? `su-models-${provider}` : undefined;
  return (
    <div className="su-pair">
      <Field f={`${base}.provider`} label="Provider" error={err(`${base}.provider`)} hint={providerHint}>
        <input
          type="text"
          list="su-providers"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={value.provider}
          placeholder={providerHint ? "any" : "e.g. openai"}
          onChange={(e) => onChange({ provider: e.target.value })}
          {...aria(`${base}.provider`, Boolean(providerHint))}
        />
      </Field>
      <Field f={`${base}.model`} label="Model" error={err(`${base}.model`)} hint={modelHint}>
        <input
          type="text"
          list={list}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={value.model}
          placeholder={embedding ? "e.g. text-embedding-3-small" : "e.g. gpt-4o-mini"}
          onChange={(e) => onChange({ model: e.target.value })}
          {...aria(`${base}.model`, Boolean(modelHint))}
        />
      </Field>
    </div>
  );
}

/** What the readiness numbers mean in comparisons, since the lower bound needs more than min_samples. */
function GateNote({ minSamples, minAgreement }: { minSamples?: number; minAgreement?: number }) {
  if (minSamples === undefined || minAgreement === undefined || minSamples < 1 || minAgreement < 0 || minAgreement > 1) return null;
  const n = Math.round(minSamples);
  const perfect = wilsonLowerBound(n, n);
  if (minAgreement >= 1) {
    return <p className="su-note small">At 1, no candidate can be Ready: the lower bound of agreement never reaches 100%.</p>;
  }
  if (perfect >= minAgreement) {
    return (
      <p className="su-note small">
        A candidate that agrees on all of its first <b className="num">{count(n)}</b> comparisons is Ready then: its lower bound is{" "}
        <b className="num">{pct(perfect)}</b>. Each disagreement adds to what it needs.
      </p>
    );
  }
  const k = comparisonsToClear(0, 0, minAgreement);
  return (
    <p className="su-note small">
      Even <b className="num">{count(n)}</b> agreeing out of {count(n)} has a lower bound of <b className="num">{pct(perfect)}</b>, below{" "}
      {pct(minAgreement, minAgreement * 100 === Math.round(minAgreement * 100) ? 0 : 1)}. A candidate that never disagrees is Ready after{" "}
      {k === undefined ? "a very long time" : <b className="num">{count(Math.max(k, n))} comparisons</b>}; one that sometimes does needs more.
    </p>
  );
}

function SpendPanel({
  draft,
  spend,
  err,
  aria,
  set,
  setCandidate,
  measured,
}: {
  draft: Draft;
  spend: ReturnType<typeof estimate>;
  err: (f: string) => string | undefined;
  aria: Aria;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  setCandidate: (key: string, patch: Partial<CandidateDraft>) => void;
  measured: Set<string>;
}) {
  const r = spend.result;
  const budget = num(draft.dailyBudget) ?? 0;
  const tag = (f: string) => (measured.has(f) ? <span className="su-tag">measured</span> : null);
  const cost = (f: string, label: ReactNode, value: string, onChange: (v: string) => void, hint: string) => (
    <div className="su-cost" data-invalid={err(f) ? true : undefined}>
      <label htmlFor={fieldId(f)}>
        {label} {tag(f)}
      </label>
      <span className="su-cost__in">
        <span aria-hidden="true">$</span>
        <input type="text" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} {...aria(f, true)} />
      </span>
      {err(f) && (
        <p className="su-err" id={`${fieldId(f)}-err`}>
          {err(f)}
        </p>
      )}
      <p className="su-hint" id={`${fieldId(f)}-hint`}>
        {hint}
      </p>
    </div>
  );
  return (
    <div className="su-spend" role="group" aria-labelledby="su-spend-h">
      <div className="su-spend__head">
        <h3 id="su-spend-h" className="su-spend__title">
          What evaluation costs a day
        </h3>
        <span className="su-tag su-tag--est">Estimate</span>
      </div>
      <p className="small muted">
        Requests a day × sample rate × each candidate&rsquo;s call{draft.judgeOn ? ", plus a judge call per pair" : ""}
        {draft.embeddingOn ? " and an embedding call" : ""}. Per-call costs depend on prompt and answer length; edit them to match yours.
      </p>
      <div className="su-cost-grid">
        <div className="su-cost" data-invalid={err("requestsPerDay") ? true : undefined}>
          <label htmlFor={fieldId("requestsPerDay")}>
            Requests a day to the source {tag("requestsPerDay")}
          </label>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={draft.requestsPerDay}
            onChange={(e) => set("requestsPerDay", e.target.value)}
            {...aria("requestsPerDay", true)}
          />
          {err("requestsPerDay") && (
            <p className="su-err" id={`${fieldId("requestsPerDay")}-err`}>
              {err("requestsPerDay")}
            </p>
          )}
          <p className="su-hint" id={`${fieldId("requestsPerDay")}-hint`}>
            {measured.has("requestsPerDay") ? "This gateway's rate since it started." : "Before sampling."}
          </p>
        </div>
        {draft.candidates.map((c, i) =>
          cost(
            `cand.${c.key}.cost`,
            <>
              <span className="model">{c.model.trim() || `Candidate ${i + 1}`}</span> call
            </>,
            c.cost,
            (v) => setCandidate(c.key, { cost: v }),
            measured.has(`cand.${c.key}.cost`) ? "Average on this gateway." : "Per call.",
          ),
        )}
        {draft.judgeOn &&
          cost("judgeCost", "Judge call", draft.judgeCost, (v) => set("judgeCost", v), measured.has("judgeCost") ? "Average evaluation cost per pair on this gateway." : "Per pair; it reads both answers.")}
        {draft.embeddingOn && cost("embeddingCost", "Embedding call", draft.embeddingCost, (v) => set("embeddingCost", v), "Per pair.")}
      </div>
      <div className="su-spend__out" aria-live="polite">
        {r ? (
          <>
            <p className="su-spend__big">
              <span className="num">{dollars(r.daily)}</span> <span className="small muted">a day, about {dollars(r.monthly)} a month</span>
            </p>
            <p className="small muted">
              {count(Math.round(r.sampledPerDay))} sampled requests × {draft.candidates.length} candidate{draft.candidates.length === 1 ? "" : "s"} ={" "}
              {count(Math.round(r.pairsPerDay))} comparisons a day
              {draft.judgeOn && r.evaluation > 0 ? <>, {dollars(r.evaluation)} of it for evaluation</> : null}.
            </p>
            {budget > 0 && r.budgetCovers !== undefined && (
              <p className="small" data-over={r.budgetCovers < 1 || undefined}>
                {r.budgetCovers >= 1 ? (
                  <>
                    Fits in the {dollars(budget)} daily budget, at {pct(r.daily / budget, 0)} of it.
                  </>
                ) : (
                  <>
                    The {dollars(budget)} budget covers about {pct(r.budgetCovers, 0)} of a day: with even traffic, sampling pauses around{" "}
                    <b className="num">{utcClock(r.budgetCovers)}</b> UTC.
                  </>
                )}
              </p>
            )}
          </>
        ) : (
          <p className="small muted">Fill in the marked numbers to see an estimate.</p>
        )}
      </div>
    </div>
  );
}

/** The UTC time a share of the day has passed: 0.5 is 12:00. */
function utcClock(share: number): string {
  const minutes = Math.round(share * 24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function RunSteps({
  draft,
  cmds,
  gateway,
  setGateway,
  auth,
  setAuth,
  origin,
  blocked,
  downloadFull,
}: {
  draft: Draft;
  cmds: ReturnType<typeof commands>;
  gateway: string;
  setGateway: (v: string) => void;
  auth: RunAuth;
  setAuth: (v: RunAuth) => void;
  origin: string;
  blocked: boolean;
  downloadFull: () => void;
}) {
  const local = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(origin);
  const rate = num(draft.sampleRate) ?? DEFAULTS.sampleRate;
  return (
    <section className="su-run" aria-labelledby="su-run-h">
      <div className="lv-head">
        <h2 className="lv-h2" id="su-run-h">
          Run it
        </h2>
        <p className="muted small">
          From an empty folder to a gateway that shadows your traffic and answers this console. The commands follow the config above and the
          address below.
        </p>
      </div>
      <div className="su-run__opts">
        <div className="su-field">
          <label htmlFor="su-gateway">Gateway address</label>
          <input id="su-gateway" type="text" inputMode="url" autoComplete="off" spellCheck={false} value={gateway} onChange={(e) => setGateway(e.target.value)} />
        </div>
        <div className="su-field">
          <label htmlFor="su-auth">Management calls sign in with</label>
          <select id="su-auth" value={auth} onChange={(e) => setAuth(e.target.value as RunAuth)} aria-describedby="su-auth-hint">
            <option value="token">The setup token</option>
            <option value="login">A dashboard login</option>
            <option value="none">Nothing (no config store)</option>
          </select>
          <p className="su-hint" id="su-auth-hint">
            {auth === "token" && "Until the gateway has an admin account, every /api call carries it."}
            {auth === "login" && "HTTP Basic with the dashboard's username and password."}
            {auth === "none" && "Promotion then answers 503: it has no routing rules to write."}
          </p>
        </div>
      </div>

      <ol className="su-steps">
        <li>
          <h3>Build the gateway with the plugin</h3>
          <p className="small muted">
            Clones Bifrost at the commit the patches were made against, adds the plugin and builds <code>bifrost-http</code>. Needs git, Go
            1.27 or later and a C compiler.
          </p>
          <CodeBlock code={cmds.build} kind="shell" label="Build commands" />
        </li>
        <li>
          <h3>Start it with your config</h3>
          <p className="small muted">
            Save the whole config.json, or add the plugin entry to the <code>plugins</code> list of the one you have, then start the gateway
            with a key for each provider.{" "}
            <button type="button" className="link" onClick={downloadFull} disabled={blocked}>
              Download config.json
            </button>
            {blocked && " (fix the marked fields first)"}
          </p>
          <CodeBlock code={cmds.start} kind="shell" label="Start commands" />
          <details className="su-more">
            <summary>Already running? Add the plugin by API</summary>
            <p className="small muted">With a config store, the plugin starts without a restart. A later update starts a fresh instance.</p>
            <CodeBlock code={cmds.apply} kind="shell" label="API call" />
          </details>
        </li>
        <li>
          <h3>Check that the plugin is on</h3>
          <p className="small muted">
            It answers with your experiment and counters at zero. A 404 that says the plugin is not enabled means the gateway did not read the
            config: check the app directory.
          </p>
          <CodeBlock code={cmds.summary} kind="shell" label="Summary request" />
        </li>
        <li>
          <h3>Send a test request</h3>
          <p className="small muted">
            {draft.allowForceHeader ? (
              <>
                The force header mirrors it whatever the sample rate. The comparison shows in the summary&rsquo;s counters within seconds.
              </>
            ) : (
              <>
                The force header is not allowed in this config, so requests are sampled at {pct(rate, rate * 100 === Math.round(rate * 100) ? 0 : 1)}.
                Comparisons show in the summary&rsquo;s counters within seconds.
              </>
            )}{" "}
            Every mirrored request calls each candidate{draft.judgeOn ? " and the judge" : ""}, at your providers&rsquo; prices.
          </p>
          <CodeBlock code={cmds.test} kind="shell" label="Test request" />
        </li>
        <li>
          <h3>Plan a promotion</h3>
          <p className="small muted">
            A dry run returns the routing rule a promotion would write and any rule in its way, and writes nothing. Until the candidate is Ready
            the gateway answers 409 with its verdict; add <code>&quot;override_reason&quot;</code> to see the plan anyway.
          </p>
          <CodeBlock code={cmds.promote} kind="shell" label="Promotion dry run" />
        </li>
        <li>
          <h3>Open this console on your gateway</h3>
          <p className="small muted">
            Add this to config.json so this console&rsquo;s <b>Sign in</b> can call the gateway from <code>{origin}</code>.{" "}
            {local
              ? "Origins on localhost are always allowed, so it matters once the console is served from elsewhere."
              : origin.startsWith("https:")
                ? "This page is served over https, so the gateway must be on https too, or on localhost."
                : ""}{" "}
            While dashboard login is off, <code>&quot;*&quot;</code> does not cover management routes: the origin has to be listed by name.
          </p>
          <CodeBlock code={cmds.origins} kind="json" label="Allowed origins" />
          <p className="small">
            <a className="link" href="#overview">
              Sign in on the overview
            </a>
          </p>
        </li>
      </ol>
    </section>
  );
}

/* Code */

function CodeBlock({
  code,
  kind,
  label,
  big,
  onColumns,
}: {
  code: string;
  kind: "json" | "shell";
  label: string;
  big?: boolean;
  /** Reports how many monospace characters fit on a line. */
  onColumns?: (cols: number) => void;
}) {
  const pre = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = pre.current;
    if (!el || !onColumns) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const inner = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      // JetBrains Mono advances 0.6 em per character.
      const cols = Math.floor(inner / (parseFloat(style.fontSize) * 0.6));
      onColumns(Math.max(40, Math.min(100, cols)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onColumns]);
  return (
    <div className="su-code" data-big={big || undefined}>
      {!big && (
        <div className="su-code__bar">
          <span>{kind === "json" ? "JSON" : "Shell"}</span>
          <CopyButton text={code} label="Copy" dark />
        </div>
      )}
      {/* Focusable so a keyboard can scroll a long line. */}
      <pre ref={pre} tabIndex={0} aria-label={label}>
        <code>{kind === "json" ? highlightJSON(code) : highlightShell(code)}</code>
      </pre>
    </div>
  );
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;

/** Keys, strings and values in three quiet colours. */
function highlightJSON(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of code.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(code.slice(last, at));
    if (m[1] !== undefined) {
      out.push(
        <span key={at} className={m[2] ? "su-k" : "su-s"}>
          {m[1]}
        </span>,
      );
      if (m[2]) out.push(m[2]);
    } else {
      out.push(
        <span key={at} className="su-v">
          {m[0]}
        </span>,
      );
    }
    last = at + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

/** Comments dimmed, nothing else. */
function highlightShell(code: string): ReactNode[] {
  return code.split("\n").map((line, i) => {
    const hash = line.trimStart().startsWith("#") ? line.indexOf("#") : line.search(/\s#\s/);
    const quoted = hash > 0 && (line.slice(0, hash).split("'").length % 2 === 0 || line.slice(0, hash).split('"').length % 2 === 0);
    const cut = hash >= 0 && !quoted ? hash : -1;
    return (
      <span key={i}>
        {cut < 0 ? line : line.slice(0, cut)}
        {cut >= 0 && <span className="su-c">{line.slice(cut)}</span>}
        {"\n"}
      </span>
    );
  });
}

function CopyButton({ text, label, disabled, dark }: { text: string; label: string; disabled?: boolean; dark?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1800);
  };
  return (
    <button
      type="button"
      className={dark ? "su-copy" : "btn btn--small"}
      onClick={copy}
      disabled={disabled}
      data-copied={state === "copied" || undefined}
    >
      {state === "copied" ? <IconCheck /> : <IconCopy />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : label}</span>
    </button>
  );
}
