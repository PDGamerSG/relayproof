/**
 * Where the live console gets its data. Two ways in:
 *
 * - Trial: the hosted demo. The page calls its own origin; Vercel rewrites
 *   /api/shadow/* and /api/demo/* to the demo backend (vercel.json), whose
 *   front door attaches the gateway's setup token. In development Vite proxies
 *   the same paths (vite.config.ts). VITE_SHADOW_API points it elsewhere.
 * - Sign in: any Bifrost gateway with the shadow plugin, called directly from
 *   the browser with the gateway's own credentials: its dashboard username and
 *   password (HTTP Basic), or its setup token before an admin exists. The
 *   gateway must allow this page's origin (client.allowed_origins).
 */
import { createContext, useContext } from "react";
import { ShadowApiError, ShadowClient } from "./shadowClient";

export const TRIAL_BASE = (import.meta.env.VITE_SHADOW_API as string | undefined)?.replace(/\/+$/, "") ?? "";

/** GET /api/demo/status: the hosted front door's own state. */
export interface DemoStatus {
  started_at: string;
  uptime_seconds: number;
  live_traffic_every_ms: number;
  live_sent: number;
  live_failed: number;
  burst_running: boolean;
  burst_sent: number;
  burst_max: number;
  /** The scorecards were cleared after an incident and seed traffic is being replayed. */
  reseeding: boolean;
  last_reset?: string;
  incidents: { model: string; error_pct: number; since: string; until: string }[];
  incident_models: string[];
  incident_ttl_seconds: number;
  canary_ttl_seconds: number;
  /** What the gateway calls: "mock" or a provider such as "anthropic". */
  upstream?: string;
  primary_model?: string;
  requests_today?: number;
  /** Requests the demo may send per UTC day; 0 means no cap. */
  daily_request_cap?: number;
  live_traffic_only_when_watched?: boolean;
  asked?: number;
  ask_max_chars?: number;
  ask_per_hour?: number;
}

/** POST /api/demo/ask: the primary model's answer to a visitor's question. */
export interface AskResponse {
  request_id: string;
  model: string;
  answer: string;
  finish_reason?: string;
  latency_ms: number;
  /** The plugin replayed the question against every candidate. */
  shadowed: boolean;
  input_tokens: number;
  output_tokens: number;
}

export interface DemoApi {
  status: () => Promise<DemoStatus>;
  /** error_pct 0 clears the incident. */
  incident: (model: string, errorPct: number) => Promise<DemoStatus>;
  traffic: (n: number) => Promise<{ queued: number }>;
  ask: (prompt: string) => Promise<AskResponse>;
}

export type GatewayAuth = { kind: "password"; username: string; password: string } | { kind: "token"; token: string };

export interface Connection {
  mode: "trial" | "gateway";
  /** What the header shows: "hosted demo" or the gateway's host. */
  label: string;
  base: string;
  client: ShadowClient;
  /** Demo controls; only the hosted trial has them. */
  demo?: DemoApi;
}

function demoApi(base: string): DemoApi {
  const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}/api/demo/${path}`, {
      method,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const p = parsed as { error?: { message?: string } } | undefined;
      throw new ShadowApiError(res.status, p?.error?.message ?? `HTTP ${res.status}`, parsed);
    }
    return parsed as T;
  };
  return {
    status: () => call<DemoStatus>("GET", "status"),
    incident: (model, errorPct) => call<DemoStatus>("POST", "incident", { model, error_pct: errorPct }),
    traffic: (n) => call<{ queued: number }>("POST", "traffic", { n }),
    ask: (prompt) => call<AskResponse>("POST", "ask", { prompt }),
  };
}

export function trialConnection(): Connection {
  return { mode: "trial", label: "hosted demo", base: TRIAL_BASE, client: new ShadowClient({ baseUrl: TRIAL_BASE }), demo: demoApi(TRIAL_BASE) };
}

/** Normalizes "localhost:8080" to "http://localhost:8080"; throws on anything that is not an http(s) origin. */
export function gatewayOrigin(input: string): string {
  let raw = input.trim();
  if (!/^https?:\/\//i.test(raw)) raw = `${/^(localhost|127\.|\[::1\])/i.test(raw) ? "http" : "https"}://${raw}`;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Use an http or https address.");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

export function gatewayConnection(origin: string, auth: GatewayAuth): Connection {
  const client = new ShadowClient(
    auth.kind === "password"
      ? { baseUrl: origin, basicAuth: { username: auth.username, password: auth.password } }
      : { baseUrl: origin, setupToken: auth.token },
  );
  return { mode: "gateway", label: new URL(origin).host, base: origin, client };
}

export const ConnectionContext = createContext<Connection>(trialConnection());
export const useConnection = () => useContext(ConnectionContext);

/** A message for any error the API or the network can produce. */
export function errorText(err: unknown): string {
  if (err instanceof ShadowApiError) {
    if (err.pluginDisabled) return "The shadow plugin is not enabled on this gateway.";
    if (err.status === 401) return "The gateway refused the credentials.";
    if (err.status === 403) return `The gateway refused the call (403): ${err.message}`;
    if (err.status === 429) return err.message;
    if (err.status >= 500) return `The backend answered ${err.status}: ${err.message}`;
    return err.message;
  }
  if (err instanceof TypeError) return "The backend is not reachable.";
  return err instanceof Error ? err.message : String(err);
}

export const modelId = (ref: { provider?: string; model: string }) => (ref.provider ? `${ref.provider}/${ref.model}` : ref.model);

export function pct(fraction: number | undefined, digits = 1): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return "–";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function ms(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "–";
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

export const count = (n: number | undefined) => (n === undefined ? "–" : n.toLocaleString("en-US"));

/** "12 s ago", "3 min ago". */
export function ago(iso: string | undefined, now: number): string {
  if (!iso) return "–";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ${m % 60} min ago`;
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Saves a Blob as a file. */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
