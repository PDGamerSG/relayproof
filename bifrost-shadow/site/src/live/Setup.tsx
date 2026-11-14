import type { RecordsState } from "./records";
import type { Summary } from "./shadowClient";

export function Setup({ data }: { data: RecordsState; summary?: Summary }) {
  return (
    <section className="wrap lv-section" aria-labelledby="setup-h">
      <h1 className="lv-h2" id="setup-h">
        Set up on your gateway
      </h1>
      <p className="muted small">{data.records.length} comparisons loaded.</p>
    </section>
  );
}
