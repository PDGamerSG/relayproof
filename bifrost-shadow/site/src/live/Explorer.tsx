import type { RecordsState } from "./records";
import type { Summary } from "./shadowClient";

export function Explorer({ data }: { data: RecordsState; summary?: Summary }) {
  return (
    <section className="wrap lv-section">
      <h1 className="lv-h2">Comparisons</h1>
      <p className="muted small">{data.records.length} loaded.</p>
    </section>
  );
}
