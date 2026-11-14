import { useMemo } from "react";
import { ago, ms } from "./backend";
import { outcomeOf } from "./Explorer";
import type { RecordsState } from "./records";
import type { ShadowRecord } from "./shadowClient";

const OUTCOME_LABEL = { pass: "agrees", fail: "disagrees", error: "failed", unscored: "unscored" } as const;

/** The newest requests through the gateway, one row per request, with each candidate's outcome. */
export function Feed({ data, now, limit = 8 }: { data: RecordsState; now: number; limit?: number }) {
  const requests = useMemo(() => {
    const byId = new Map<string, ShadowRecord[]>();
    for (let i = data.records.length - 1; i >= 0 && byId.size <= limit; i--) {
      const r = data.records[i];
      const list = byId.get(r.request_id);
      if (list) list.push(r);
      else byId.set(r.request_id, [r]);
    }
    return [...byId.values()].slice(0, limit);
  }, [data.records, limit]);

  if (!data.loaded || requests.length === 0) return null;

  return (
    <section className="wrap lv-section lv-feed" aria-labelledby="feed-h">
      <div className="lv-head">
        <h2 className="lv-h2" id="feed-h">
          Latest traffic
        </h2>
        <p className="muted small">
          The newest requests through this gateway. Each was answered by the primary model first; the candidates answered the same request
          afterwards, out of the caller&rsquo;s sight. Open <a href="#comparisons">Comparisons</a> to read any of them in full.
        </p>
      </div>
      <ol className="lv-feed__list">
        {requests.map((group) => {
          const first = group[0];
          return (
            <li key={first.request_id}>
              <p className="lv-feed__prompt">{first.prompt || <i className="muted">Prompt not stored</i>}</p>
              <p className="lv-feed__primary small">
                <span className="model">{first.primary.model}</span> answered in <span className="num">{ms(first.primary_latency_ms)}</span>
                <span className="muted num"> {ago(first.created_at, now)}</span>
              </p>
              <ul className="lv-feed__cands">
                {group
                  .slice()
                  .sort((a, b) => a.candidate.model.localeCompare(b.candidate.model))
                  .map((r) => {
                    const o = outcomeOf(r);
                    return (
                      <li key={r.id} data-outcome={o}>
                        <span className="model">{r.candidate.model}</span> {OUTCOME_LABEL[o]}
                        {r.judge && (
                          <span className="num muted">
                            {" "}
                            {r.judge.primary_score} vs {r.judge.candidate_score}
                          </span>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
