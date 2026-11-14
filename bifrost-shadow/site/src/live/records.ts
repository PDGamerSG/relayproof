/**
 * Comparison records for the views that work on individual pairs: the trend
 * charts, the comparisons explorer, the judge check and the report. The API
 * keeps the newest records in a ring buffer; this loads up to 500 of them and
 * refreshes them while the console is open.
 */
import { useEffect, useState } from "react";
import { wilsonLowerBound } from "../lib/stats";
import { errorText, modelId, type Connection } from "./backend";
import { poll, type RolloutEvent, type ShadowRecord } from "./shadowClient";

export const RECORD_LIMIT = 500;

export interface RecordsState {
  /** Oldest first. */
  records: ShadowRecord[];
  /** How many the gateway holds; can exceed what was loaded. */
  total: number;
  loaded: boolean;
  error?: string;
}

const EMPTY: RecordsState = { records: [], total: 0, loaded: false };

export function useRecords(conn: Connection, enabled: boolean, intervalMs = 15000): RecordsState {
  const [state, setState] = useState<RecordsState>(EMPTY);

  // A new connection starts from nothing.
  useEffect(() => setState(EMPTY), [conn]);

  useEffect(() => {
    if (!enabled) return;
    return poll(
      () => conn.client.records({ limit: RECORD_LIMIT }),
      intervalMs,
      (page) => {
        const records = [...page.records].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
        setState({ records, total: page.total, loaded: true });
      },
      (err) => setState((s) => ({ ...s, error: errorText(err) })),
    );
  }, [conn, enabled, intervalMs]);

  return state;
}

export const candidateKey = (r: { experiment: string; candidate: { provider?: string; model: string } }) =>
  `${r.experiment}|${modelId(r.candidate)}`;

/** True when a record counts toward agreement: scored pairs and candidate errors, as in the scorecard. */
export const counts = (r: ShadowRecord) => Boolean(r.candidate_error) || r.pass_basis !== "unscored";

export interface TrendPoint {
  /** Position among the counted records, from 1. */
  n: number;
  at: number;
  agreement: number;
  lower: number;
  pass: boolean;
  error: boolean;
}

/** Running agreement and its 95% Wilson lower bound, record by record, for one candidate. */
export function agreementSeries(records: ShadowRecord[], key: string): TrendPoint[] {
  const out: TrendPoint[] = [];
  let n = 0;
  let passes = 0;
  for (const r of records) {
    if (candidateKey(r) !== key || !counts(r)) continue;
    n++;
    const error = Boolean(r.candidate_error);
    const pass = !error && r.pass;
    if (pass) passes++;
    out.push({ n, at: Date.parse(r.created_at), agreement: passes / n, lower: wilsonLowerBound(passes, n), pass, error });
  }
  return out;
}

/** Rollout events for one candidate, oldest first. */
export function eventsFor(events: RolloutEvent[] | undefined, experiment: string, candidate: string): RolloutEvent[] {
  return (events ?? [])
    .filter((e) => e.experiment === experiment && modelId(e.candidate) === candidate)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** How many more agreeing comparisons would lift the lower bound to `target`; undefined if it cannot within `cap`. */
export function comparisonsToClear(passes: number, n: number, target: number, cap = 5000): number | undefined {
  for (let k = 0; k <= cap; k++) {
    if (wilsonLowerBound(passes + k, n + k) >= target) return k;
  }
  return undefined;
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
