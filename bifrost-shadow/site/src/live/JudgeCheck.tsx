import type { RecordsState } from "./records";
import type { Summary } from "./shadowClient";

/** Judge check: how far to trust the LLM judge behind the scorecards. */
export function JudgeCheck({ data, summary }: { data: RecordsState; summary?: Summary }) {
  return (
    <section className="wrap lv-section" aria-labelledby="judge-h">
      <h1 className="lv-h2" id="judge-h">
        Judge check
      </h1>
      <p className="muted small">
        {data.records.filter((r) => r.judge).length} judged comparisons loaded; judge {summary?.judge_model ?? "not configured"}.
      </p>
    </section>
  );
}
