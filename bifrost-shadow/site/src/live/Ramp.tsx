import { count, pct } from "./backend";
import type { CanaryRamp } from "./shadowClient";

/** The shares a ramp moves through after `start`: the usual 10/25/50/100 ladder, up to `end`. */
export function rampSteps(start: number, end: number): number[] {
  const ladder = [0.05, 0.1, 0.25, 0.5, 1].filter((s) => s > start + 1e-9 && s <= end + 1e-9);
  return [start, ...ladder];
}

export function holdText(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 6) / 10} h`;
}

/**
 * A ramp's steps as a track: the steps already served, the one serving now
 * (with how far it is towards its request quota) and the ones still to come.
 */
export function RampTrack({ ramp, compact = false }: { ramp: CanaryRamp; compact?: boolean }) {
  const quota = ramp.min_requests > 0 ? Math.min(1, ramp.step_requests / ramp.min_requests) : 1;
  const label = ramp.steps
    .map((s, i) => `${pct(s, 0)}${i < ramp.current_step ? " done" : i === ramp.current_step ? (ramp.completed ? " reached" : " now") : ""}`)
    .join(", ");
  return (
    <div className="lv-ramp" data-compact={compact}>
      <ol className="lv-ramp__steps" aria-label={`Ramp steps: ${label}`}>
        {ramp.steps.map((s, i) => {
          const state = i < ramp.current_step ? "done" : i === ramp.current_step ? (ramp.completed ? "done" : "now") : "next";
          return (
            <li key={i} data-state={state}>
              <span className="lv-ramp__bar" aria-hidden="true">
                {state === "now" && <span style={{ width: `${(quota * 100).toFixed(1)}%` }} />}
              </span>
              <span className="lv-ramp__share num">{pct(s, 0)}</span>
            </li>
          );
        })}
      </ol>
      {!compact && (
        <p className="small muted">
          {ramp.completed
            ? `Reached the last step, ${pct(ramp.steps[ramp.steps.length - 1], 0)}. The guard keeps watching it.`
            : (ramp.reason ??
              `Step ${ramp.current_step + 1} of ${ramp.steps.length}: ${count(ramp.step_requests)} of ${count(ramp.min_requests)} candidate requests, at least ${holdText(ramp.hold_seconds)} per step.`)}
          {!ramp.completed && ramp.next_weight !== undefined && <> Next: {pct(ramp.next_weight, 0)}, if it stays healthy.</>}
        </p>
      )}
    </div>
  );
}
