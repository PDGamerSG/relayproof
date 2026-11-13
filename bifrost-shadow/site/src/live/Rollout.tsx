import { useState } from "react";
import { ago, clock, count, errorText, modelId, ms, pct, saveBlob, useConnection, type DemoStatus } from "./backend";
import type { Notify } from "./LiveApp";
import type { Canary, Rollouts, RolloutEvent, TargetHealth } from "./shadowClient";

interface PanelProps {
  rollouts?: Rollouts;
  status?: DemoStatus;
  now: number;
  notify: Notify;
  refresh: () => Promise<void>;
}

const HEALTH_LABEL = { watching: "Watching", healthy: "Healthy", unhealthy: "Unhealthy" } as const;

function HealthRow({ label, h }: { label: string; h: TargetHealth }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{count(h.requests)}</td>
      <td>{pct(h.error_rate)}</td>
      <td>{ms(h.p50_ms)}</td>
      <td>{ms(h.p95_ms)}</td>
    </tr>
  );
}

function CanaryCard({ canary, now, notify, refresh }: { canary: Canary; now: number; notify: Notify; refresh: () => Promise<void> }) {
  const { client } = useConnection();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const health = canary.health;
  const rollback = async () => {
    setBusy(true);
    try {
      const res = await client.rollback({
        experiment: canary.experiment,
        candidate: modelId(canary.candidate),
        reason: "rolled back from the live console",
      });
      notify("ok", res.action === "none" ? "That canary was already gone." : `${canary.candidate.model} rolled back; ${canary.source.model} takes its traffic again.`);
      await refresh();
    } catch (err) {
      notify("error", errorText(err));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <article className="lv-canary">
      <header className="lv-canary__head">
        <p>
          <span className="model">{canary.candidate.model}</span> serves <b className="num">{pct(canary.weight, 0)}</b> of{" "}
          <span className="model">{canary.source.model}</span> traffic
        </p>
        <span className="lv-health" data-status={health.status}>
          {HEALTH_LABEL[health.status]}
        </span>
      </header>
      <p className="small muted">
        Live since {ago(canary.since, now)}
        {canary.override && " · promoted with an override, so the guard watches live health only"}
      </p>
      {health.reason && <p className="lv-canary__reason small">{health.reason}</p>}
      <table className="lv-table num">
        <caption className="sr-only">Live health of the canary and its source</caption>
        <thead>
          <tr>
            <th scope="col">Target</th>
            <th scope="col">Requests</th>
            <th scope="col">Errors</th>
            <th scope="col">p50</th>
            <th scope="col">p95</th>
          </tr>
        </thead>
        <tbody>
          <HealthRow label={canary.candidate.model} h={health.candidate} />
          <HealthRow label={canary.source.model} h={health.source} />
        </tbody>
      </table>
      <div className="lv-canary__actions">
        {confirming ? (
          <>
            <button type="button" className="btn btn--small btn--sun" onClick={rollback} disabled={busy}>
              {busy ? "Rolling back…" : "Confirm rollback"}
            </button>
            <button type="button" className="btn btn--small btn--ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="btn btn--small btn--ghost" onClick={() => setConfirming(true)}>
            Roll back now
          </button>
        )}
      </div>
    </article>
  );
}

export function CanaryPanel({ rollouts, status, now, notify, refresh }: PanelProps) {
  return (
    <div className="lv-panel">
      <h3 className="h3">Live canaries</h3>
      {!rollouts && <p className="lv-empty">Loading…</p>}
      {rollouts && rollouts.canaries.length === 0 && (
        <p className="lv-empty">
          No canary is live. Promote a ready candidate from its scorecard: the gateway then sends it a share of real traffic, and the
          guard starts watching.
        </p>
      )}
      {rollouts?.canaries.map((c) => (
        <CanaryCard key={c.rule_id + modelId(c.candidate)} canary={c} now={now} notify={notify} refresh={refresh} />
      ))}
      {rollouts && (
        <p className="small muted lv-panel__note">
          Auto rollback is <b>{rollouts.auto_rollback ? "on" : "off"}</b>.
          {status && ` Live traffic: one request every ${(status.live_traffic_every_ms / 1000).toFixed(0)} s.`}
        </p>
      )}
    </div>
  );
}

function remaining(until: string, now: number): string {
  const s = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function IncidentPanel({ status, rollouts, now, notify, refresh }: PanelProps) {
  const demo = useConnection().demo!;
  const [busy, setBusy] = useState<string>();
  const [burst, setBurst] = useState(40);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      notify("ok", ok);
      await refresh();
    } catch (err) {
      notify("error", errorText(err));
    } finally {
      setBusy(undefined);
    }
  };

  const models = status?.incident_models ?? ["gpt-4o-mini", "llama-3.1-8b"];
  return (
    <div className="lv-panel">
      <h3 className="h3">Simulate a provider incident</h3>
      <p className="small muted">
        The mock upstream fails a share of one model&rsquo;s calls with HTTP 503. Break the model that is live as a canary and the guard
        rolls it back once it has seen enough requests. When the incident ends, the demo clears the scorecards and replays traffic.
      </p>
      {status?.reseeding && (
        <p className="lv-reseed small" role="status">
          The incident is over: the demo cleared the scorecards and is replaying traffic, so the next visitor starts fresh. Verdicts
          return within a minute or two.
        </p>
      )}
      <ul className="lv-incidents">
        {models.map((model) => {
          const inc = status?.incidents.find((i) => i.model === model);
          const live = rollouts?.canaries.some((c) => c.candidate.model === model);
          return (
            <li key={model} data-failing={!!inc}>
              <div>
                <p className="model">{model}</p>
                <p className="small">
                  {inc ? (
                    <>
                      Failing <b className="num">{inc.error_pct}%</b> of calls · clears in <span className="num">{remaining(inc.until, now)}</span>
                    </>
                  ) : (
                    <span className="muted">Healthy{live ? " · live canary" : ""}</span>
                  )}
                </p>
              </div>
              {inc ? (
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  disabled={busy !== undefined}
                  onClick={() => act(model, () => demo.incident(model, 0), `${model} recovered.`)}
                >
                  {busy === model ? "…" : "Recover"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--small btn--sun"
                  disabled={busy !== undefined}
                  onClick={() =>
                    act(model, () => demo.incident(model, 60), `${model} now fails 60% of its calls. ${live ? "Watch the canary." : "Promote it first to see the guard act."}`)
                  }
                >
                  {busy === model ? "…" : "Fail 60% of calls"}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="lv-burst">
        <p className="small muted">
          The guard needs about ten requests to the canary before it judges. At a 10% share that takes a couple of minutes of live traffic;
          a burst gets there sooner.
        </p>
        <div className="lv-burst__row">
          <label className="small">
            <span className="sr-only">Requests in the burst</span>
            <select value={burst} onChange={(e) => setBurst(Number(e.target.value))} disabled={status?.burst_running}>
              {[20, 40, 60].map((n) => (
                <option key={n} value={n}>
                  {n} requests
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn btn--small btn--ghost"
            disabled={busy !== undefined || status?.burst_running}
            onClick={() => act("burst", () => demo.traffic(burst), `Sending ${burst} requests through the gateway.`)}
          >
            {status?.burst_running ? "Burst running…" : "Send a burst"}
          </button>
        </div>
      </div>
    </div>
  );
}

const ACTION_LABEL: Record<RolloutEvent["action"], string> = {
  promote: "Promoted",
  rollback: "Rolled back",
  auto_rollback: "Rolled back by the guard",
};

export function History({ rollouts, now }: { rollouts?: Rollouts; now: number }) {
  if (!rollouts) return <p className="lv-empty">Loading…</p>;
  if (rollouts.events.length === 0) return <p className="lv-empty">Nothing yet. Promotions and rollbacks appear here as they happen.</p>;
  return (
    <ol className="lv-events">
      {rollouts.events.slice(0, 30).map((e) => (
        <li key={e.id} data-action={e.action}>
          <p className="lv-events__when num small muted" title={e.at}>
            {clock(e.at)} <span>({ago(e.at, now)})</span>
          </p>
          <p className="lv-events__what">
            <b>{ACTION_LABEL[e.action]}</b> <span className="model">{e.candidate.model}</span>
            {e.action === "promote" ? (
              <>
                {" "}
                to <b className="num">{pct(e.weight, 0)}</b> of <span className="model">{e.source.model}</span>
                {e.override && <span className="lv-tag">override</span>}
              </>
            ) : null}
          </p>
          {e.reason && <p className="small muted">{e.reason}</p>}
          {e.action === "auto_rollback" && e.health && (
            <p className="small muted num">
              Candidate errors {pct(e.health.candidate.error_rate)} over {count(e.health.candidate.requests)} requests; source{" "}
              {pct(e.health.source.error_rate)}.
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

export function Downloads() {
  const conn = useConnection();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const files = [
    { key: "scorecards", label: "Scorecards, CSV", get: () => conn.client.exportCSV("scorecards"), name: "scorecards.csv" },
    { key: "records", label: "Comparisons, CSV", get: () => conn.client.exportCSV("records"), name: "comparisons.csv" },
    {
      key: "json",
      label: "Everything, JSON",
      get: async () => new Blob([JSON.stringify(await conn.client.exportJSON(), null, 2)], { type: "application/json" }),
      name: "shadow-export.json",
    },
  ];
  const download = async (f: (typeof files)[number]) => {
    setBusy(f.key);
    setError(undefined);
    try {
      saveBlob(await f.get(), `relayproof-${stamp()}-${f.name}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="lv-downloads small">
      <span className="muted">Download:</span>
      {files.map((f) => (
        <button key={f.key} type="button" className="link" onClick={() => download(f)} disabled={busy !== undefined}>
          {busy === f.key ? "Preparing…" : f.label}
        </button>
      ))}
      {conn.mode === "trial" && (
        <a className="link" href={`${conn.base}/api/shadow/summary`}>
          Raw summary API
        </a>
      )}
      {error && <span className="lv-error">{error}</span>}
    </div>
  );
}
