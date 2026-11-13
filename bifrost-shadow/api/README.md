# Connecting a frontend to Bifrost Shadow

The backend is the Bifrost gateway itself: the shadow plugin and its `/api/shadow/*` routes run
inside the same process that serves model traffic. A frontend (dashboard, admin console, demo
site) talks to that gateway over HTTP. Nothing else needs to run.

```
browser / Next.js ──HTTP──► Bifrost gateway :8080
                              ├─ /v1/chat/completions   live model traffic (mirrored by the plugin)
                              ├─ /api/shadow/*          scorecards, records, promotion, canaries, export
                              └─ /api/routing/rules     routing rules (promotion writes these for you)
```

| File | What it is |
|---|---|
| [`openapi.yaml`](openapi.yaml) | OpenAPI 3.1 description of every `/api/shadow/*` route. Checked against live gateway responses. |
| [`client/shadowClient.ts`](client/shadowClient.ts) | Dependency-free TypeScript client with full types. Copy it into the frontend. |
| [`../examples/shadow-demo/dev.sh`](../examples/shadow-demo/dev.sh) | A long-running local backend with seeded data and live traffic, no API keys. |

## 1. Start a backend

Build the gateway once (from the repository root):

```bash
bifrost-shadow/scripts/setup.sh
```

Then start the development backend and leave it running:

```bash
BIFROST_BIN="$(pwd)/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/dev.sh
```

It starts a mock model upstream and the gateway on `http://localhost:8080`, replays 300 requests so
both candidates have verdicts (`gpt-4o-mini` ready, `llama-3.1-8b` not ready), then sends one live
request per second so counters move. It prints the setup token (default `shadow-dev-token`). The
canary guard is on, and the mock can simulate an incident:

```bash
curl -X POST 'http://127.0.0.1:18080/admin/incident?model=gpt-4o-mini&error_pct=60'
```

## 2. Authentication

| Gateway state | What the frontend sends |
|---|---|
| Config store, no dashboard login yet (the dev backend) | Header `X-Bifrost-Setup-Token: <token>` |
| Dashboard auth enabled | Browser: `POST /api/session/login` with `{"username","password"}` sets an HTTP-only `token` cookie; then call with `credentials: "include"`. Server-side code: `Authorization: Basic base64(user:password)`. |
| No config store | Nothing. Promotion and rollback answer `503` (there are no routing rules to write); everything else works. |

Keep the setup token and admin password on a server (Next.js route handler, proxy) in production.
The session cookie is `SameSite=Lax`: it works across ports on `localhost`, but a frontend on a
different site must go through a same-origin proxy or use Basic auth server-side.

## 3. CORS

- Origins on `localhost` (any port) are always allowed. `http://localhost:3000` works out of the box.
- Any other origin must be listed by name in the gateway's `config.json`:
  `"client": { "allowed_origins": ["https://shadow.example.com"] }`. While dashboard auth is off,
  the wildcard `"*"` does **not** cover management routes: an unlisted origin gets `403`.
- Avoiding CORS entirely: proxy `/api/shadow` through the frontend's own server.

Next.js (`next.config.js`):

```js
module.exports = {
  async rewrites() {
    return [{ source: "/api/shadow/:path*", destination: "http://localhost:8080/api/shadow/:path*" }];
  },
};
```

Vite (`vite.config.ts`):

```ts
export default defineConfig({
  server: {
    proxy: {
      "/api/shadow": {
        target: "http://localhost:8080",
        headers: { "X-Bifrost-Setup-Token": "shadow-dev-token" },
      },
    },
  },
});
```

With a proxy, create the client with `baseUrl: ""`.

## 4. Using the client

```ts
import { ShadowClient, ShadowApiError, poll } from "./shadowClient";

const shadow = new ShadowClient({
  baseUrl: "http://localhost:8080",
  setupToken: "shadow-dev-token", // or credentials: "include" after login, or basicAuth server-side
});

// Live scorecards: poll the summary.
const stop = poll(() => shadow.summary(), 3000, (s) => render(s.pairs), console.error);

// Promote with the server's checks; explain a refusal.
try {
  const plan = await shadow.planPromotion({ experiment: "gpt-4o cost-down", candidate: "openai/gpt-4o-mini", weight: 0.1 });
  showPlan(plan.rule.targets, plan.warnings);
  await shadow.promote({ experiment: "gpt-4o cost-down", candidate: "openai/gpt-4o-mini", weight: 0.1 });
} catch (err) {
  if (err instanceof ShadowApiError) {
    const notReady = err.notReady(); // { verdict, verdict_reason, evidence }
    const conflict = err.conflict(); // { conflicts[], warnings[], rule }
  }
}
```

React hook:

```ts
function useShadow<T>(fetcher: () => Promise<T>, everyMs = 3000) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  useEffect(() => poll(fetcher, everyMs, (d) => { setData(d); setError(undefined); }, setError), []);
  return { data, error };
}
// const { data: summary } = useShadow(() => shadow.summary());
// const { data: rollouts } = useShadow(() => shadow.rollouts(), 2000);
```

## 5. Endpoints and what a screen needs

| Screen | Call | Notes |
|---|---|---|
| Overview tiles | `GET /api/shadow/summary` | `counters`, `spend_today_usd` of `daily_budget_usd`, `budget_exhausted`, `active_canaries`. Poll every 2-5 s. |
| Scorecard table | same, `pairs[]` | One row per experiment/candidate. |
| Disagreements | `GET /api/shadow/records?experiment=&candidate=&outcome=fail` | Side-by-side `primary_answer` / `candidate_answer`, `judge.reason`, `pass_basis`. `limit` ≤ 500, `total` for paging. |
| One comparison | `GET /api/shadow/records/{id}` | |
| Promote dialog | `POST /api/shadow/promote` with `dry_run: true`, then without | Show `rule.targets` (the traffic split) and `warnings` before confirming. |
| Live canaries | `GET /api/shadow/rollouts` | `canaries[].health`: candidate vs source requests, error rate, p50/p95. Poll every 2 s while any canary is live. |
| Rollout history | same, `events[]` | Newest first; `auto_rollback` events come from the canary guard and carry the `health` that triggered them. |
| Rollback button | `POST /api/shadow/rollback` | `action`: `update` (other candidates stay), `delete` (rule gone), `none` (rule was already removed). |
| Download | `GET /api/shadow/export?format=csv&kind=scorecards` | Also `kind=records`, or `format=json` for everything. |
| Reset | `DELETE /api/shadow/records` | Confirm first. Spend, canaries and the rollout log are kept. |

### Values a UI should map

- `verdict`: `collecting` (not enough scored evidence; show `verdict_reason`), `promising` (point
  estimate passes, the lower bound not yet), `ready`, `not_ready`. Only `ready` promotes without an
  override reason.
- `agreement_rate` with `agreement_lower_bound`: show both; the lower bound is what readiness uses.
- `pass_basis` on a record: `judge`, `exact`, `semantic`, `lexical` decided quality;
  `tool_selection` and `json_schema` are failed required gates; `tool_arguments` means same tools,
  different arguments, no judge; `unscored` means no usable signal (often a failed judge call, see
  `judge_error`).
- Agent metrics on a scorecard: `tool_turns`, `tool_name_match_rate`, `tool_call_match_rate`,
  `tool_diffs` (`missing`, `extra`, `different_tool`, `different_args`).
- `judge_error_rate` above `thresholds.max_judge_error_rate` withholds the verdict: surface it.
- Canary `health.status`: `watching` (fewer than `min_requests` candidate requests), `healthy`,
  `unhealthy` (rolled back automatically when `auto_rollback` is on).

### Errors

Errors use Bifrost's body: `{"is_bifrost_error": false, "status_code": 404, "error": {"message": "..."}}`.
`404` with "shadow plugin is not enabled" means the plugin is off (`client.status()` returns
`plugin_disabled`). Promotion's `409`s carry structured bodies (`NotReadyRefusal`,
`ConflictRefusal` in the spec); a `409` with only a message means the requested priority is taken.

## 6. Checking the contract

The spec and client were checked against a running gateway: every response field of every route
(summary, records, record, 404 error, canary-rule, promote 200/409/dry run, rollouts, rollback,
export) is declared in `openapi.yaml` with a matching type, and the client's calls (including
refusal parsing, polling and CSV/JSON export) were run end to end against the dev backend.
