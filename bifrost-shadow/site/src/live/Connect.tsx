import { useState, type FormEvent } from "react";
import { gatewayConnection, gatewayOrigin, trialConnection, type Connection, type GatewayAuth } from "./backend";

const SAVED = "relayproof.gateway";

interface Saved {
  url: string;
  kind: GatewayAuth["kind"];
  username: string;
}

function loadSaved(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(SAVED) ?? "null") as Partial<Saved> | null;
    if (s) return { url: s.url ?? "", kind: s.kind === "token" ? "token" : "password", username: s.username ?? "" };
  } catch {
    // Storage blocked or corrupt: start empty.
  }
  return { url: "", kind: "password", username: "" };
}

function save(s: Saved) {
  try {
    localStorage.setItem(SAVED, JSON.stringify(s));
  } catch {
    // Not remembering the form is fine.
  }
}

/**
 * The two ways into the console: the hosted trial, or a sign-in to your own
 * gateway with its own credentials. Secrets stay in memory only.
 */
export function ConnectPanel({ conn, onConnect }: { conn: Connection; onConnect: (c: Connection) => void }) {
  const [saved] = useState(loadSaved);
  const [open, setOpen] = useState(conn.mode === "gateway");
  const [url, setUrl] = useState(saved.url);
  const [kind, setKind] = useState<GatewayAuth["kind"]>(saved.kind);
  const [username, setUsername] = useState(saved.username);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    let origin: string;
    try {
      origin = gatewayOrigin(url);
    } catch {
      setError("Enter the gateway's address, for example http://localhost:8080 or https://gateway.example.com.");
      return;
    }
    const insecure = origin.startsWith("http://") && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(origin);
    if (window.location.protocol === "https:" && insecure) {
      setError("This page is served over https, so the browser blocks calls to a plain-http gateway. Use https, or localhost.");
      return;
    }
    const auth: GatewayAuth = kind === "password" ? { kind, username: username.trim(), password: secret } : { kind, token: secret.trim() };
    const next = gatewayConnection(origin, auth);
    setBusy(true);
    const state = await next.client.status();
    setBusy(false);
    if (state === "ok") {
      save({ url: origin, kind, username: kind === "password" ? username.trim() : "" });
      setSecret("");
      onConnect(next);
      return;
    }
    if (state === "unauthorized") {
      setError(kind === "password" ? "The gateway refused that username and password." : "The gateway refused that setup token.");
    } else if (state === "plugin_disabled") {
      setError("Signed in, but the shadow plugin is not enabled on that gateway.");
    } else {
      setError(
        `Could not reach ${origin}. Check that it is running, that the address is right, and that its config lists ${window.location.origin} in client.allowed_origins.`,
      );
    }
  };

  return (
    <div className="lv-connect" aria-label="How to connect">
      <div className="lv-connect__opts" role="radiogroup" aria-label="Connection">
        <button
          type="button"
          role="radio"
          aria-label="Trial: the hosted demo gateway, no account"
          aria-checked={conn.mode === "trial" && !open}
          className="lv-connect__opt"
          data-on={conn.mode === "trial" && !open}
          onClick={() => {
            setOpen(false);
            if (conn.mode !== "trial") onConnect(trialConnection());
          }}
        >
          <b>Trial</b>
          <span>Hosted demo gateway. No account, nothing to install.</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-label="Sign in to your own Bifrost gateway"
          aria-checked={conn.mode === "gateway" || open}
          className="lv-connect__opt"
          data-on={conn.mode === "gateway" || open}
          onClick={() => setOpen(true)}
        >
          <b>Sign in</b>
          <span>Your own Bifrost gateway, with its dashboard login.</span>
        </button>
      </div>

      {open && conn.mode === "gateway" && (
        <div className="lv-connect__signed">
          <p className="small">
            Signed in to <b className="model">{conn.label}</b>.
          </p>
          <button type="button" className="btn btn--ghost btn--small" onClick={() => onConnect(trialConnection())}>
            Sign out
          </button>
        </div>
      )}

      {open && conn.mode !== "gateway" && (
        <form className="lv-connect__form" onSubmit={signIn}>
          <label className="lv-field">
            <span className="small">Gateway address</span>
            <input
              type="text"
              inputMode="url"
              autoComplete="url"
              placeholder="http://localhost:8080"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </label>
          <fieldset className="lv-connect__kind">
            <legend className="sr-only">Credentials</legend>
            <label>
              <input type="radio" name="kind" checked={kind === "password"} onChange={() => setKind("password")} /> Dashboard login
            </label>
            <label>
              <input type="radio" name="kind" checked={kind === "token"} onChange={() => setKind("token")} /> Setup token
            </label>
          </fieldset>
          {kind === "password" ? (
            <div className="lv-connect__pair">
              <label className="lv-field">
                <span className="small">Username</span>
                <input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
              </label>
              <label className="lv-field">
                <span className="small">Password</span>
                <input type="password" autoComplete="current-password" value={secret} onChange={(e) => setSecret(e.target.value)} required />
              </label>
            </div>
          ) : (
            <label className="lv-field">
              <span className="small">Setup token (before the gateway has an admin account)</span>
              <input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} required />
            </label>
          )}
          {error && (
            <p className="lv-error small" role="alert">
              {error}
            </p>
          )}
          <div className="lv-connect__actions">
            <button type="submit" className="btn btn--sun btn--small" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <p className="small muted">
              Credentials stay in this tab&rsquo;s memory and go only to that gateway, on each call. The gateway must list{" "}
              <code>{window.location.origin}</code> in <code>client.allowed_origins</code>.
            </p>
          </div>
        </form>
      )}
    </div>
  );
}
