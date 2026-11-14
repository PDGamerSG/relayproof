import type { RecordsState } from "./records";
import type { Summary } from "./shadowClient";

export function PolicyLab({ data }: { data: RecordsState; summary?: Summary }) {
  return (
    <section className="wrap lv-section" aria-labelledby="policy-h">
      <h1 className="lv-h2" id="policy-h">
        Policy lab
      </h1>
      <p className="muted small">{data.records.length} comparisons loaded.</p>
    </section>
  );
}
