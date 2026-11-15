# HTTP API reference

Every route RelayProof adds to a Bifrost gateway, plus the routes of the hosted demo's front door. This page lists what each route is for. Request and response shapes are not repeated here:

- [`bifrost-shadow/api/openapi.yaml`](../../bifrost-shadow/api/openapi.yaml) is the OpenAPI 3.1 description of every `/api/shadow/*` route, with all fields and error bodies.
- [`bifrost-shadow/api/client/shadowClient.ts`](../../bifrost-shadow/api/client/shadowClient.ts) is a typed TypeScript client with one method per route (`summary`, `records`, `disagreements`, `record`, `reset`, `promote`, `planPromotion`, `rollback`, `rollouts`, `canaryRule`, `exportJSON`, `exportCSV`, `status`, at `bifrost-shadow/api/client/shadowClient.ts:510-595`).
- [`bifrost-shadow/api/README.md`](../../bifrost-shadow/api/README.md) explains authentication, CORS, local development and which call each screen needs.

Paths in the "Defined in" columns are relative to the repository root.

## Routes

### Gateway routes (`/api/shadow/*`)

The shadow plugin's handler registers these routes on the gateway itself, next to model traffic (`bifrost-shadow/transports/bifrost-http/handlers/shadow.go:56-66`). The server registers them with the same middlewares as the rest of Bifrost's management API (`bifrost-shadow/patches/0001-register-shadow-plugin.patch:107`). If the plugin is not loaded, every route answers `404` with "shadow plugin is not enabled; add it to plugins in config.json or enable it from the plugins page" (`bifrost-shadow/transports/bifrost-http/handlers/shadow.go:68-74`).

| Method | Path | Auth | What it does | Defined in |
| --- | --- | --- | --- | --- |
| `GET` | `/api/shadow/summary` | Management API | Counters, today's spend against the daily budget, the plugin's settings and thresholds, and one scorecard per experiment and candidate with its verdict. Cheap enough to poll every few seconds. | `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:76-82`, `bifrost-shadow/api/openapi.yaml:35-47` |
| `GET` | `/api/shadow/records` | Management API | Stored comparisons, newest first, with `total` for paging. Filters: `experiment`, `candidate`, `outcome` (`all`, `pass`, `fail`, `error`), `limit` (default 50, at most 500) and `offset`. | `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:84-123`, `bifrost-shadow/plugins/shadow/api.go:80-93`, `bifrost-shadow/api/openapi.yaml:48-78` |
| `GET` | `/api/shadow/records/{id}` | Management API | One comparison by ID. | `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:125-140`, `bifrost-shadow/api/openapi.yaml:95-115` |
| `DELETE` | `/api/shadow/records` | Management API | Clears records and counters and restarts the collection window. Today's spend, live canaries and the rollout log are kept. | `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:142-153`, `bifrost-shadow/plugins/shadow/api.go:108-111`, `bifrost-shadow/api/openapi.yaml:79-94` |
| `GET` | `/api/shadow/canary-rule` | Management API | Builds the routing-rule body that would send `weight` (default 0.1) of the source model's traffic to a candidate, at `priority` (default 10). Writes nothing. | `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:155-206`, `bifrost-shadow/api/openapi.yaml:230-256` |
| `POST` | `/api/shadow/promote` | Management API | Gives a candidate a share of its source model's live traffic. It refuses a candidate that is not `ready` unless the body has an `override_reason`, merges candidates into one rule per source, refuses conflicting rules, takes an optional `ramp`, and records a `promote` event. With `dry_run: true` it returns the plan and writes nothing. | `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:208-304`, `bifrost-shadow/api/openapi.yaml:116-185` |
| `POST` | `/api/shadow/rollback` | Management API | Takes a candidate out of its canary rule so the source model gets its share back, and records a `rollback` event. `action` in the answer is `update` (other candidates stay), `delete` (the rule is gone) or `none`. | `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:306-386`, `bifrost-shadow/api/openapi.yaml:186-217` |
| `GET` | `/api/shadow/rollouts` | Management API | Live canaries with their health and ramp state, and the rollout log, newest first. | `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:388-396`, `bifrost-shadow/api/openapi.yaml:218-229` |
| `GET` | `/api/shadow/export` | Management API | A download. `format=json` (the default) returns the summary, every stored record that matches the filters, and the rollouts. `format=csv` returns one table: `kind=scorecards` (the default) or `kind=records`. The record filters apply, `limit` and `offset` do not. | `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:398-448`, `bifrost-shadow/api/openapi.yaml:257-288` |

"Management API" means whatever the gateway's own `/api` routes require (`bifrost-shadow/api/openapi.yaml:11-14`, `bifrost-shadow/api/openapi.yaml:29-33`):

- A gateway with a config store and no dashboard login: the header `X-Bifrost-Setup-Token: <token>`.
- A gateway with dashboard auth: the session cookie from `POST /api/session/login`, or `Authorization: Basic <base64(user:password)>`.
- A gateway without a config store: nothing. Promotion and rollback then answer `503` because there are no routing rules to write (`bifrost-shadow/transports/bifrost-http/handlers/shadow.go:231-233`).

Browsers also need CORS: the gateway must list the page's origin in `client.allowed_origins`. See `bifrost-shadow/api/README.md:77-83`.

### Hosted demo front door (`/api/shadow/*` and `/api/demo/*`)

The hosted backend runs the front door as its only public listener (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:1-28`). The site calls its own origin, and Vercel rewrites `/api/shadow/*` and `/api/demo/*` to the backend (`bifrost-shadow/site/vercel.json:8-11`). The front door attaches the setup token itself and drops the caller's `Authorization`, `Cookie`, `Origin` and `Referer` headers (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:246-266`), so these routes need no credentials.

| Method | Path | Auth | What it does | Defined in |
| --- | --- | --- | --- | --- |
| `GET`, `HEAD` | `/api/shadow/summary`, `/api/shadow/records`, `/api/shadow/records/{id}`, `/api/shadow/rollouts`, `/api/shadow/export`, `/api/shadow/canary-rule` | None | Forwarded to the gateway routes above. | `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:276-291`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:335-343` |
| `POST` | `/api/shadow/promote`, `/api/shadow/rollback` | None | Forwarded to the gateway routes above. | `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:287-288` |
| any other | `/api/shadow/*`, including `DELETE /api/shadow/records` | None | Answers `403` "this route is not exposed by the public demo". | `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:274-275`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:336-338` |
| `GET` | `/api/demo/status` | None | The demo's own state: live and burst traffic counters, active incidents, the models a visitor may break, the incident and canary time limits, `upstream` (`mock` or `anthropic`), `primary_model`, `requests_today` against `daily_request_cap`, and the question limits. | `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:345-415` |
| `POST` | `/api/demo/incident` | None | Body `{"model": "...", "error_pct": 60}`. Makes that share of a candidate's upstream calls fail. `error_pct` 0 clears it, and it clears itself after 3 minutes. | `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:417-440`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:95` |
| `POST` | `/api/demo/traffic` | None | Body `{"n": 20}`. Sends `n` requests through the gateway in the background, four at a time, one burst at a time, and answers `202` with `{"queued": n}`. `n` is at most 60 on the mock and 30 on real models. | `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:619-648`, `bifrost-shadow/deploy/entrypoint.sh:46`, `bifrost-shadow/deploy/entrypoint.sh:60` |
| `POST` | `/api/demo/ask` | None | Body `{"prompt": "..."}`. Sends a visitor's question to the primary model with `x-bf-shadow: force` and returns `request_id`, `model`, `answer`, `latency_ms`, `shadowed` and token counts. The candidates' records carry the same `request_id`. At most 600 characters and 20 questions an hour per address. | `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:739-849`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:109-110` |
| `GET` | `/healthz` | None | `ok` while the gateway is healthy, otherwise `503` "gateway starting". Render's health check uses it. Vercel does not rewrite it. | `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:312-318`, `render.yaml:16` |

Every POST counts toward a limit of 30 per client address per minute (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:98`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:965-974`). In Claude mode the front door may send 400 requests per UTC day in total (`bifrost-shadow/deploy/entrypoint.sh:40`). A janitor rolls back canaries that have been live for 30 minutes (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:96`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:881-930`).

Do not call the hosted backend from scripts or during development. Every call to its `/api/shadow/*`, `/api/demo/status` or `/api/demo/ask` marks the console as watched (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:340`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:372`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:756`). In Claude mode the front door then sends a real request every 15 seconds for the next 3 minutes (`bifrost-shadow/deploy/entrypoint.sh:41-42`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:672-674`), and each of those requests costs money.

## Try it

Against a local gateway, with no API keys (the mock upstream plays every model):

```bash
# From the repository root, once: build the gateway with the plugin
bifrost-shadow/scripts/setup.sh

# Start a seeded local backend and leave it running (it prints the setup token)
BIFROST_BIN="$(pwd)/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/dev.sh

# In another terminal. shadow-dev-token is dev.sh's default token.
curl -s -H "X-Bifrost-Setup-Token: shadow-dev-token" http://localhost:8080/api/shadow/summary

curl -s -H "X-Bifrost-Setup-Token: shadow-dev-token" \
  'http://localhost:8080/api/shadow/records?candidate=openai/llama-3.1-8b&outcome=fail&limit=5'

curl -s -X POST http://localhost:8080/api/shadow/promote \
  -H "X-Bifrost-Setup-Token: shadow-dev-token" -H "Content-Type: application/json" \
  -d '{"experiment":"gpt-4o cost-down","candidate":"openai/gpt-4o-mini","weight":0.1,"dry_run":true}'
```

`dev.sh` listens on port 8080 with the mock on 18080 unless `PORT` and `MOCK_ADDR` say otherwise (`bifrost-shadow/examples/shadow-demo/dev.sh:15-16`). Change the URLs to match.

To try the front door's `/api/demo/*` routes, run the hosted image locally. Without `ANTHROPIC_API_KEY` it runs on the mock upstream (`bifrost-shadow/deploy/entrypoint.sh:24-27`):

```bash
docker build -f bifrost-shadow/deploy/Dockerfile -t relayproof-demo .
docker run --rm -p 10000:10000 -e BIFROST_SETUP_TOKEN=dev relayproof-demo
curl -s localhost:10000/api/demo/status
```

## Errors

Gateway routes and the front door both answer errors in Bifrost's body: `{"is_bifrost_error": false, "status_code": 404, "error": {"message": "..."}}` (`bifrost-shadow/api/README.md:193`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:1024-1031`).

| Status | When |
| --- | --- |
| 400 | Invalid JSON body; `experiment` or `candidate` missing; `weight` outside 0.0001 to 1; a negative `priority`, `limit` or `offset`; `outcome` not `all`, `pass`, `fail` or `error`; `format` not `json` or `csv`; `kind` not `scorecards` or `records`; an invalid `ramp` (`bifrost-shadow/transports/bifrost-http/handlers/shadow.go:102-123`, `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:235-270`, `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:427-446`). On the front door: a malformed incident, burst or question body (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:420-433`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:621-631`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:755-769`). |
| 401 | A gateway that requires a setup token or a login got neither. Bifrost's own auth sends this, not the shadow handler. The client reports 401 and 403 as `unauthorized` (`bifrost-shadow/api/client/shadowClient.ts:584`). |
| 403 | A wrong setup token, or a browser origin that is not in `client.allowed_origins` while dashboard auth is off (`bifrost-shadow/api/README.md:80-82`). On the front door: a route outside the allowlist (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:337`). |
| 404 | The plugin is not enabled; the record does not exist; the experiment or candidate is unknown; a rollback found no canary rule for the pair (`bifrost-shadow/transports/bifrost-http/handlers/shadow.go:71`, `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:136`, `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:197-199`, `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:355`). |
| 409 | Promotion refused: the candidate is not `ready` and there is no override reason (body carries `verdict`, `verdict_reason`, `evidence`); another routing rule conflicts (body carries `conflicts`, `warnings`, `rule`); the priority is taken; or another canary's unfinished ramp still needs the share (`bifrost-shadow/transports/bifrost-http/handlers/shadow.go:275-293`). |
| 429 | Front door only: more than 30 POSTs a minute from one address, more than 20 questions an hour, the daily request cap, or a burst already running (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:634`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:640`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:773`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:969`). |
| 500 | Reset, promotion storage, rollback or CSV writing failed (`bifrost-shadow/transports/bifrost-http/handlers/shadow.go:148`, `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:294-295`, `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:360-362`, `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:439`). |
| 502 | Front door only: the gateway is not reachable, or the primary model failed to answer a question (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:268`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:803`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:819`). |
| 503 | Promotion or rollback on a gateway without a config store (`bifrost-shadow/transports/bifrost-http/handlers/shadow.go:232`, `bifrost-shadow/transports/bifrost-http/handlers/shadow.go:321`). On the front door: `/healthz` while the gateway starts (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:314`). |
