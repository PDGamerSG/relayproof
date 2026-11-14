import type { RecordsState } from "./records";
import type { RolloutEvent, Summary } from "./shadowClient";

/** Placeholder: drift per candidate, recent window against the one before. */
export function DriftWatch(_props: { data: RecordsState; summary?: Summary; events?: RolloutEvent[] }) {
  return null;
}
