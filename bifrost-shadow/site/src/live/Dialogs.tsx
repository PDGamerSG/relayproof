import { useEffect, useState } from "react";
import { Dialog } from "../components/Dialog";
import { count, errorText, modelId, ms, pct, useConnection } from "./backend";
import { ShadowApiError, type Answer, type PairSummary, type Promotion, type ShadowRecord } from "./shadowClient";

const SHARES = [0.05, 0.1, 0.25, 0.5];

export function PromoteDialog({
  pair,
  current,
  defaultShare = 0.1,
  onClose,
  onDone,
}: {
  pair: PairSummary;
  current?: number;
  /** Share preselected for a new canary. */
  defaultShare?: number;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { client } = useConnection();
  const ready = pair.verdict === "ready";
  const candidate = modelId(pair.candidate);
  const [weight, setWeight] = useState(current ?? defaultShare);
  const [reason, setReason] = useState("");
  const [plan, setPlan] = useState<Promotion>();
  const [planError, setPlanError] = useState<string>();
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Dry run on every change: the gateway's own plan, with its checks.
  useEffect(() => {
    let live = true;
    setPlanError(undefined);
    setConflicts([]);
    const t = setTimeout(() => {
      client
        .planPromotion({
          experiment: pair.experiment,
          candidate,
          weight,
          override_reason: ready ? undefined : reason.trim() || "preview of a promotion with an override",
        })
        .then((p) => live && setPlan(p))
        .catch((err) => {
          if (!live) return;
          setPlan(undefined);
          const c = err instanceof ShadowApiError ? err.conflict() : undefined;
          if (c) setConflicts(c.conflicts);
          setPlanError(errorText(err));
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [client, pair.experiment, candidate, weight, ready, reason]);

  const promote = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await client.promote({
        experiment: pair.experiment,
        candidate,
        weight,
        override_reason: ready ? undefined : reason.trim(),
      });
      onDone(
        `${pair.candidate.model} now serves ${pct(weight, 0)} of ${pair.source.model} traffic (rule ${res.action === "create" ? "created" : "updated"}).`,
      );
    } catch (err) {
      const nr = err instanceof ShadowApiError ? err.notReady() : undefined;
      const c = err instanceof ShadowApiError ? err.conflict() : undefined;
      if (c) setConflicts(c.conflicts);
      setError(nr ? `Refused: ${nr.verdict_reason}. Give an override reason to promote anyway.` : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !busy && (ready || reason.trim().length >= 8) && !planError;
  return (
    <Dialog
      open
      onClose={onClose}
      variant="modal"
      title={current !== undefined ? "Change the canary share" : "Promote to a canary"}
      subtitle={
        <>
          <span className="model">{pair.candidate.model}</span> takes a share of the requests sent to{" "}
          <span className="model">{pair.source.model}</span>.
        </>
      }
    >
      <div className="lv-promote">
        {!ready && (
          <p className="lv-warn" role="alert">
            This candidate is {pair.verdict.replace("_", " ")}: {pair.verdict_reason}. The gateway refuses it unless you say why.
          </p>
        )}

        <fieldset className="lv-shares">
          <legend className="small">Share of {pair.source.model} traffic</legend>
          {SHARES.map((s) => (
            <label key={s} data-on={weight === s}>
              <input type="radio" name="share" value={s} checked={weight === s} onChange={() => setWeight(s)} />
              <span className="num">{pct(s, 0)}</span>
            </label>
          ))}
        </fieldset>

        {!ready && (
          <label className="lv-field">
            <span className="small">Override reason, at least 8 characters (recorded in the rollout log)</span>
            <textarea
              rows={2}
              value={reason}
              maxLength={300}
              placeholder="e.g. trying the failure path on purpose"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}

        <div className="lv-plan" aria-live="polite">
          <p className="small muted">The gateway&rsquo;s plan (dry run, nothing written yet)</p>
          {plan && (
            <>
              <div className="lv-split-bar" role="img" aria-label={plan.rule.targets.map((t) => `${t.model} ${pct(t.weight, 0)}`).join(", ")}>
                {plan.rule.targets.map((t) => (
                  <span key={`${t.provider}/${t.model}`} style={{ flexGrow: t.weight }} data-cand={t.model === pair.candidate.model}>
                    <span className="model">{t.model}</span> <b className="num">{pct(t.weight, 0)}</b>
                  </span>
                ))}
              </div>
              <p className="small">
                {plan.action === "create" ? "Creates" : "Updates"} routing rule <b>{plan.rule.name}</b>, priority{" "}
                <span className="num">{plan.rule.priority}</span>, matching <code>{plan.rule.cel_expression}</code>.
              </p>
              {plan.warnings.map((w) => (
                <p key={w} className="lv-warn small">
                  {w}
                </p>
              ))}
            </>
          )}
          {!plan && !planError && <p className="small muted">Asking the gateway…</p>}
          {planError && <p className="lv-warn small">{planError}</p>}
          {conflicts.length > 0 && (
            <ul className="lv-warn small">
              {conflicts.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <p className="lv-error small" role="alert">
            {error}
          </p>
        )}

        <div className="lv-promote__actions">
          <button type="button" className="btn btn--ghost btn--small" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--sun btn--small" onClick={promote} disabled={!canSubmit}>
            {busy ? "Promoting…" : `Send ${pct(weight, 0)} to ${pair.candidate.model}`}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

const BASIS_TEXT: Record<string, string> = {
  judge: "Decided by the judge",
  exact: "Exact match",
  semantic: "Decided by embedding similarity",
  lexical: "Decided by lexical overlap",
  tool_selection: "Called a different tool",
  json_schema: "JSON shape differs",
  tool_arguments: "Same tools, different arguments",
  unscored: "No usable signal",
};

function AnswerView({ answer }: { answer?: Answer }) {
  if (!answer) return <p className="muted small">Not stored.</p>;
  return (
    <>
      {answer.text && <p className="lv-rec__text">{answer.text}</p>}
      {answer.tool_calls?.map((t, i) => (
        <pre key={i} className="lv-rec__tool">
          {t.name}({t.arguments})
        </pre>
      ))}
      {!answer.text && !answer.tool_calls?.length && <p className="muted small">(empty)</p>}
    </>
  );
}

function RecordView({ r }: { r: ShadowRecord }) {
  const c = r.comparison;
  return (
    <article className="lv-rec">
      <header className="lv-rec__head small">
        <span className="verdict" data-verdict="not_ready">
          {r.candidate_error ? "Error" : "Fail"}
        </span>
        <span>{r.candidate_error ? "Candidate call failed" : BASIS_TEXT[r.pass_basis ?? ""] ?? r.pass_basis}</span>
        {r.stream && <span className="lv-tag">streamed</span>}
        <span className="muted num">{new Date(r.created_at).toLocaleTimeString()}</span>
      </header>
      {r.prompt && <p className="lv-rec__prompt">{r.prompt}</p>}
      <div className="lv-rec__pair">
        <div>
          <p className="lv-rec__who small">
            Primary <span className="model">{r.primary.model}</span> <span className="muted num">{ms(r.primary_latency_ms)}</span>
          </p>
          <AnswerView answer={r.primary_answer} />
        </div>
        <div data-side="candidate">
          <p className="lv-rec__who small">
            Candidate <span className="model">{r.candidate.model}</span>{" "}
            <span className="muted num">{r.candidate_error ? "" : ms(r.candidate_latency_ms)}</span>
          </p>
          {r.candidate_error ? <p className="lv-error small">{r.candidate_error}</p> : <AnswerView answer={r.candidate_answer} />}
        </div>
      </div>
      {r.judge && (
        <p className="small lv-rec__judge">
          Judge: primary <b className="num">{r.judge.primary_score}</b>, candidate <b className="num">{r.judge.candidate_score}</b>
          {r.judge.reason && <> · &ldquo;{r.judge.reason}&rdquo;</>} · candidate shown {r.judge.candidate_shown_first ? "first" : "second"}
        </p>
      )}
      {r.judge_error && <p className="small lv-error">Judge call failed: {r.judge_error}</p>}
      {c && (
        <p className="small muted num">
          Lexical {pct(c.lexical_similarity)}
          {c.semantic_similarity !== undefined && <> · semantic {pct(c.semantic_similarity)}</>}
          {" · "}length ratio {c.length_ratio.toFixed(2)}
          {c.tool_call_diff && <> · tool calls: {c.tool_call_diff.replace("_", " ")}</>}
          {c.json_match === false && <> · JSON shape differs</>}
        </p>
      )}
    </article>
  );
}

export function DisagreementsDialog({ pair, onClose }: { pair: PairSummary; onClose: () => void }) {
  const { client } = useConnection();
  const [records, setRecords] = useState<ShadowRecord[]>([]);
  const [total, setTotal] = useState<number>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = async (offset: number) => {
    setLoading(true);
    try {
      const page = await client.disagreements(pair.experiment, modelId(pair.candidate), 15, offset);
      setRecords((prev) => (offset === 0 ? page.records : [...prev, ...page.records]));
      setTotal(page.total);
      setError(undefined);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair.experiment, pair.candidate.model]);

  return (
    <Dialog
      open
      onClose={onClose}
      variant="sheet"
      title="Disagreements"
      subtitle={
        <>
          <span className="model">{pair.candidate.model}</span> against <span className="model">{pair.source.model}</span>
          {total !== undefined && <>, {count(total)} so far, newest first</>}
        </>
      }
    >
      {error && <p className="lv-error small">{error}</p>}
      {records.map((r) => (
        <RecordView key={r.id} r={r} />
      ))}
      {total === 0 && <p className="lv-empty">No disagreements stored for this candidate.</p>}
      {total !== undefined && records.length < total && (
        <button type="button" className="btn btn--ghost btn--small" onClick={() => load(records.length)} disabled={loading}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
      {loading && records.length === 0 && <p className="lv-empty">Loading…</p>}
    </Dialog>
  );
}
