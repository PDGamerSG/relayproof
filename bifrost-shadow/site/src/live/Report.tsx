import type { DemoStatus } from "./backend";
import type { RecordsState } from "./records";
import type { Rollouts, Summary } from "./shadowClient";

export function Report({ data }: { data: RecordsState; summary?: Summary; rollouts?: Rollouts; status?: DemoStatus }) {
  return (
    <section className="wrap lv-section">
      <h1 className="lv-h2">Report</h1>
      <p className="muted small">{data.records.length} loaded.</p>
    </section>
  );
}
