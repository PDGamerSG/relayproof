import type { RecordsState } from "./records";
import type { Summary } from "./shadowClient";

export function Performance({ data }: { data: RecordsState; summary?: Summary }) {
  return (
    <section className="wrap lv-section" aria-labelledby="perf-h">
      <h1 className="lv-h2" id="perf-h">
        Performance
      </h1>
      <p className="muted small">{data.records.length} comparisons loaded.</p>
    </section>
  );
}
