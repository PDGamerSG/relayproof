> Draft pull request description for `maximhq/bifrost`. It has not been posted; posting needs the team's explicit go-ahead.

# feat(plugins): shadow traffic evaluation with readiness scorecards, gated canary promotion and automatic rollback

## Summary

Adds a built-in `shadow` plugin that mirrors a sample of live chat completions (streaming
included) to one or more candidate models after the primary answer has been sent, scores each
candidate answer against the answer the client received, and reports per-candidate readiness,
latency and cost. A `ready` candidate can be promoted to a weighted canary routing rule from the
new **Models → Shadow Traffic** dashboard page or from the API.

- Off by default. When it is not enabled in `config.json` or through `/api/plugins`, it is not
  registered and none of its hooks run.
- The client always receives the primary model's answer, unchanged. Candidate, judge and
  embedding calls run on a bounded worker pool as internal requests
  (`PrepareContextForInternalRequest`).
- Readiness uses the 95% Wilson lower bound of the agreement rate, not the raw rate. Tool
  selection and JSON structure are required gates; a failed judge call leaves a pair unscored.
- `POST /api/shadow/promote` writes the canary routing rule through the config store and the
  routing engine's reload, exactly as the routing-rules API does. It requires a `ready` verdict
  (or a recorded override reason), keeps one rule per source model, and partially evaluates
  other rules' CEL to refuse a canary an earlier rule would shadow.
- A canary guard watches live traffic per target and, with `canary.auto_rollback`, rolls an
  unhealthy candidate back by itself. Every promotion and rollback is logged with its evidence.
- An optional guarded ramp (`ramp` in the promote body: `steps`, `min_requests`,
  `hold_seconds`) lets the guard raise the canary's share step by step while it stays healthy,
  like Argo Rollouts canary steps or Flagger's `stepWeights`. Each step is judged on its own
  traffic and written into the same rule; `ramp` and `ramp_complete` events record it.

Base: `ed62e4b`.

## Motivation

Moving traffic to a cheaper or newer model is the most direct cost lever an operator has, and
the gateway already has the pieces around it: routing rules with weighted targets, model-catalog
prices, and internal sub-requests. What is missing is evidence. Operators cannot tell whether a
candidate is good enough on their own traffic without serving its answers to users. Offline eval
sets do not match production prompts, and an A/B test exposes users before the answer is known.
Shadow traffic answers the question with the gateway's own traffic and no user impact, and
connects the answer to the rollout mechanism the gateway already has.

## What changed

### New files

| Path | Contents |
|---|---|
| `plugins/shadow/` | New Go module `github.com/maximhq/bifrost/plugins/shadow` (`version` 0.1.0, `changelog.md`) |
| `plugins/shadow/main.go` | Plugin lifecycle; HTTP transport hooks (`x-bf-shadow` request header, `x-bf-shadow: sampled` response header); `PreLLMHook` (match, allow-list, sample, budget, snapshot); `PostLLMHook` (collect, stream accumulation to the final chunk, non-blocking hand-off); capture and marker maps keyed by request ID; janitor; daily budget; pricing |
| `plugins/shadow/worker.go` | Worker pool, internal-request context, candidate replay, embedding similarity, judge call, pass rule, panic recovery |
| `plugins/shadow/compare.go` | Token F1, length ratio, finish-reason normalization, tool-call multiset matching, JSON-shape matching, cosine similarity, Wilson lower bound, percentiles |
| `plugins/shadow/judge.go` | Judge prompt with randomized A/B order, tolerant reply parsing, mapping back to primary and candidate |
| `plugins/shadow/store.go` | Ring buffer, optional JSONL persistence with torn-line tolerance, record filters, scorecards, verdicts |
| `plugins/shadow/api.go` | Summary, records, reset, canary-rule builder (including wildcard sources) |
| `plugins/shadow/ledger.go` | Daily spend ledger shared across plugin reloads, persisted beside `persist_path`, with per-job reservations |
| `plugins/shadow/rollout.go` | Rollout log, active canaries, live per-target health, the canary guard with its rollback and ramp hooks, ramp validation (`PlanRamp`) |
| `plugins/shadow/config.go` | Config types, defaults and validation |
| `plugins/shadow/compare_test.go`, `judge_test.go`, `plugin_test.go`, `readiness_test.go`, `ledger_test.go`, `rollout_test.go` | Unit and component tests, benchmarks |
| `transports/bifrost-http/handlers/shadow.go`, `shadow_test.go` | `/api/shadow/*` handler (summary, records, reset, canary-rule, promote, rollback, rollouts, export) and its tests |
| `transports/bifrost-http/handlers/shadow_rollout.go`, `shadow_rollout_test.go`, `shadow_ramp_test.go` | Server-side promotion and rollback: verdict gate, merge into one rule per source, CEL overlap check, the rollback and ramp hooks; tests include effective traffic shares with two candidates and a ramp driven by the guard |
| `ui/app/workspace/shadow/` | Dashboard page: counter tiles, scorecard, disagreements sheet, promote dialog, not-enabled view |
| `ui/lib/store/apis/shadowApi.ts`, `ui/lib/types/shadow.ts`, `ui/lib/utils/shadow.ts`, `ui/lib/utils/shadow.test.ts` | RTK Query endpoints, types, helpers and their vitest cases |
| `docs/features/shadow-traffic.mdx` | Feature page |
| `tests/e2e/features/shadow-traffic/` | Playwright page object, data factories and specs for the dashboard page |
| `examples/shadow-demo/` | Key-free demo: deterministic OpenAI-compatible mock upstream, load generator, dataset, gateway config, `run.sh`. Can be split into a separate PR if maintainers prefer |

New test files sit next to new source files only. Tests for existing code go into the existing
`validator_test.go`.

### Modified upstream files

| Change | Files | What |
|---|---|---|
| Plugin registration and wiring | `transports/bifrost-http/lib/config.go`, `transports/bifrost-http/server/plugins.go`, `transports/bifrost-http/server/server.go`, `transports/go.mod` | Adds `shadow` to the built-in plugin names and to `loadBuiltinPlugin`. Registers it only when its config is present and enabled, at built-in order 10, after the semantic cache (a cache hit short-circuits before sampling); otherwise marks it disabled. `wireShadowPlugin` runs on bootstrap and on plugin reload and passes the client's `ChatCompletionRequest` and `EmbeddingRequest`, a price function backed by `ModelCatalog.CalculateCostForUsage`, and the canary guard's rollback and ramp hooks. The shadow handler gets a routing-rule writer built from the config store and the server's `ReloadRoutingRule`/`RemoveRoutingRule` (nil without a config store, in which case promotion answers 503). `github.com/google/cel-go` moves from indirect to direct. The handler resolves the plugin per request, like the cache handler, so enabling or reloading through `/api/plugins` needs no restart. `go.mod` requires `plugins/shadow v0.1.0` with a `replace` to `../plugins/shadow` until the module is tagged. |
| Config schema | `transports/config.schema.json`, `transports/bifrost-http/lib/validator_test.go` | A `name: "shadow"` branch in the plugins `allOf` describing every config field with its default and range, `shadow` added to the built-in names in the plugin `name` description, and two tests: `TestValidateConfigSchema_ShadowPlugin` (a full valid config, a wildcard source, and twelve malformed configs that must fail) and `TestValidateConfigSchema_ShadowCoversEverySetting` (by reflection, every field of `shadow.Config`, `Thresholds`, `JudgeConfig` and `EmbeddingConfig` is in the schema and nothing else is). |
| Docs navigation | `docs/docs.json` | Adds `features/shadow-traffic` after `features/complexity-router`. |
| Dashboard API plumbing | `ui/lib/store/apis/baseApi.ts`, `ui/lib/store/apis/index.ts` | `ShadowSummary` and `ShadowRecords` tag types (invalidated together on reset) and the `shadowApi` export. |
| Dashboard page entry and strings | `ui/components/navigation/navItems.tsx`, `ui/lib/types/schemas.ts`, `ui/locales/{de,en,es,fr,it,ja,ko,pt,ru,zh-CN,zh-TW}/{models,shell}.json` | Sidebar entry **Models → Shadow Traffic** (`FlaskConical` icon, shown with the same access check as Routing Rules), the zod schema for the promote dialog's whole-percent weight (1 to 100), and the page's strings in all 11 UI languages. |

No `Makefile` or `go.work` change is needed: `make setup-workspace` and `make test-plugins`
discover `plugins/*/` automatically.

## Configuration

Minimal `config.json`:

```json
{
  "plugins": [{
    "enabled": true,
    "name": "shadow",
    "config": {
      "sample_rate": 0.1,
      "experiments": [{
        "source": { "provider": "openai", "model": "gpt-4o" },
        "candidates": [{ "provider": "openai", "model": "gpt-4o-mini" }]
      }],
      "judge": { "provider": "openai", "model": "gpt-4o" },
      "daily_budget_usd": 20
    }
  }]
}
```

| Field | Default | Notes |
|---|---|---|
| `sample_rate` | `0.1` | In (0, 1]; `experiments[].sample_rate` overrides it |
| `experiments[].source` | required | `model: "*"` matches every model; an empty provider matches any provider |
| `judge`, `embedding` | none | Optional signals; `judge.sample_rate` (default 1.0) is the share of pairs judged |
| `max_concurrency`, `queue_size`, `timeout_seconds` | `4`, `256`, `60` | Worker pool, pending jobs, per-call timeout |
| `daily_budget_usd` | `0` (unlimited) | Candidate, judge and embedding spend per UTC day |
| `virtual_keys` | all | Mirror only requests made with these virtual keys (ID, name or value) |
| `allow_force_header` | `false` | Honour `x-bf-shadow: force` (see below) |
| `max_records`, `store_payloads`, `max_payload_chars`, `persist_path` | `5000`, `true`, `8000`, none | Retention and privacy |
| `pricing` | catalog | Manual prices keyed by `provider/model` or `model`; they take precedence over the catalog |
| `thresholds` | `min_samples` 20, `min_agreement` 0.9, `max_error_rate` 0.05, `quality_tolerance` 1.0, `semantic_threshold` 0.85, `lexical_threshold` 0.6 | Readiness |

Per-request control: `x-bf-shadow: off` never mirrors a request. `x-bf-shadow: force` mirrors
it regardless of the sample rate (it must still match an experiment, the allow-list and the
budget), but only with `allow_force_header: true`: shadow calls skip governance, so a force
header any caller can send would be spend on demand. Responses to mirrored requests carry
`x-bf-shadow: sampled`.

Shadow calls and MCP: MCP adds its tools to a request before plugin hooks run, and its agent
loop runs outside the plugin pipeline. The replay therefore drops the tools MCP added (client,
connect and code-mode tools; the caller's own tools stay), and every candidate, judge and
embedding call sets empty MCP client and tool allow-lists, so no MCP tool runs on a shadow
call. `extra_params` reach the candidate when the caller opted into passing them through.

API: `GET /api/shadow/summary`, `GET /api/shadow/records`, `GET /api/shadow/records/{id}`,
`DELETE /api/shadow/records` (audited; keeps today's spend so a reset never lifts the budget),
`GET /api/shadow/canary-rule`, `POST /api/shadow/promote` (optionally with a `ramp`),
`POST /api/shadow/rollback`, `GET /api/shadow/rollouts`, `GET /api/shadow/export`. All answer
`404` while the plugin is not enabled.

## Cost on the request flow

**Before.** With the plugin not enabled, which is the default, it is not registered: no hook
runs and the request path is unchanged. The only always-on addition is the `/api/shadow/*`
routes, which are management API calls, not inference.

**After, with the plugin enabled.** `cd plugins/shadow && go test -run '^$' -bench . -benchmem -count=5`,
windows/amd64, 32 threads, Go 1.27.4, medians:

| Path | Benchmark | ns/op | B/op | allocs/op |
|---|---|---|---|---|
| Chat request that matches no experiment | `BenchmarkPreLLMHookNotEligible` | 67.8 | 0 | 0 |
| Matches an experiment, not sampled | `BenchmarkPreLLMHookEligibleNotSampled` | 98.6 | 0 | 0 |
| Same, on every core at once | `BenchmarkPreLLMHookEligibleNotSampledParallel` | 54.0 | 0 | 0 |
| Not sampled while a sampled request is in flight (capture-map paths) | `BenchmarkUnsampledWhileActive` | 160.1 | 0 | 0 |
| `PostLLMHook` with nothing captured | `BenchmarkPostLLMHookNoCapture` | 2.9 | 0 | 0 |
| Response-headers hook, not sampled | `BenchmarkResponseHeadersHookNotSampled` | 2.2 | 0 | 0 |
| Plugin's own work per streamed chunk | `BenchmarkStreamChunkHook` | 0.37 | 0 | 0 |
| Per-chunk transport interceptor with only this plugin (the wrapper is core's) | `BenchmarkStreamChunkInterceptorOnePlugin` | 180.9 | 240 | 2 |
| Sampled request: snapshot, capture, hand-off | `BenchmarkSampledRequest` | 9,560 | about 3,400 | 33 |

What these numbers do and do not cover:

- The `PostLLMHook` and response-headers figures are the fast paths taken while no sampled
  request is in flight (an atomic counter is zero). While one is, an unsampled request takes the
  capture-map paths in both hooks; `BenchmarkUnsampledWhileActive` measures that case.
- Every eligible request, sampled or not, counts itself for the monthly projection with atomics
  in a per-experiment, cache-line-padded slot, so the unsampled path takes no lock;
  `BenchmarkPreLLMHookEligibleNotSampledParallel` runs it on every core at once.
- The benchmarks run without a `virtual_keys` allow-list.
- `BenchmarkSampledRequest` builds a fresh `BifrostContext` inside the loop, so its 31
  allocations include the benchmark's own context. TODO: split that out.
- The sampled cost is paid only by sampled requests, at `sample_rate`. Candidate, judge and
  embedding calls happen after the response, on the worker pool, and never on the request path.
- Gateway latency under load with the plugin enabled has not been measured. TODO.

Not benchmarked, with reason: the config schema change (config load only), the `/api/shadow/*`
handler (management API, not inference), and the dashboard page (not on the request path).

### Retained memory

| What | Keyed by | Entry size | Bound | Freed when |
|---|---|---|---|---|
| Captures (`sync.Map`) | request ID | Request snapshot (JSON of messages, tools, parameters; not truncated), last user turn truncated to `max_payload_chars`, and for streams an accumulator whose text and per-call tool arguments stop growing once they pass 64 KiB | One per sampled request whose response is not complete. No fixed count limit | Final `PostLLMHook`, failed primary, cache hit, retried attempt, or the janitor (every minute, entries older than 10 minutes) |
| Markers (`sync.Map`) | request ID | One `time.Time` | One per sampled request until its headers are written | Response-headers hook, or the janitor after 10 minutes (Go SDK callers, requests that fail before headers) |
| Job queue | none | Snapshot reference, prompt, primary answer, usage | `queue_size` | Taken by a worker |
| Ring buffer | none | One record; with `store_payloads`, prompt and both answer texts truncated to `max_payload_chars` (tool-call arguments kept as returned) | `max_records` | Overwritten oldest-first; cleared by reset |
| JSONL file (opt-in) | none | One line per record | Rewritten with the newest `max_records` records once it holds twice that many lines, so at most `2 × max_records` lines on disk and on replay | Compaction or reset |
| Traffic counters | experiment index | Three atomics in a cache-line-padded slot | Number of experiments | Reset |

Nothing stream-sized is stored in `BifrostContext`; the context carries only the parsed
`x-bf-shadow` mode.

## Tests

From the verification log (`TESTING.md` in the contribution repository):

| Suite | Command | Platform | Result |
|---|---|---|---|
| Plugin (64 tests) | `cd plugins/shadow && go test -count=3 ./...` | windows/amd64 | pass |
| Plugin under CPU load | four test binaries at once, each `-test.count=3 -test.cpu=1,4` | windows/amd64 | pass |
| Plugin, race detector | `go test -race -count=2 ./...` | linux/amd64 | pass |
| HTTP handler (9 tests) | `cd transports && go test -race -count=2 -run Shadow ./bifrost-http/handlers/` | linux/amd64 | pass |
| Config schema (2 tests) | `go test -run TestValidateConfigSchema_Shadow ./bifrost-http/lib/` | windows/amd64, linux/amd64 | pass |
| Vet | `go vet` on `plugins/shadow` and `bifrost-http/server`, `handlers`, `lib` | windows/amd64 | clean |
| Demo tools | `cd examples/shadow-demo && GOWORK=off go vet ./... && go test ./...` | windows/amd64 | pass |
| Dashboard helpers (31 tests) | `cd ui && npx vitest run lib/utils/shadow.test.ts` | windows/amd64, linux/amd64 | pass |
| Dashboard types | `cd ui && npm run typecheck` | windows/amd64 | pass |
| Dashboard strings | `node scripts/i18nCheck.mjs` scoped to the new files | windows/amd64 | exit 0, all 10 translated catalogs in parity with `en` |
| Dashboard build | `cd ui && npm run build` | windows/amd64, linux/amd64 | pass |

The plugin tests cover sampling and per-experiment rates, the `x-bf-shadow` header in both
directions, streaming accumulation up to the final chunk, skipping cache hits, failed primaries
and a candidate equal to the served model, candidate errors and panics, judge parsing with
randomized order, budget exhaustion, queue overflow, stale-capture and marker sweeping, JSONL
persistence with torn lines and compaction, reset, verdicts and Wilson bounds, canary rules
including wildcard sources, weight bounds and priority, pricing overrides, MCP isolation, the
opt-in force header, request IDs shared by concurrent requests, streamed refusals,
`extra_params`, explicit zero thresholds, panics in pricing and storage, and shutdown with jobs
in flight.

A code review pass after the first version found more defects, from a primary answer blanked
before scoring with `store_payloads: false` to MCP tools reaching the replay; each is fixed with
a regression test, and `TESTING.md` lists them. The dashboard E2E suite found one more: a second
promote of the same pair failed with HTTP 409 because every canary rule had priority 10.

Red before green, for the two bugs found while checking the running gateway and dashboard:

- `TestShadowResponseHeaderAcrossContexts`: the gateway runs LLM hooks on a child of the
  transport context, so a context flag set in `PreLLMHook` never reached the headers hook. The
  test reproduces the split and failed before the fix (sampled request IDs tracked in the
  plugin, matched through `X-Bifrost-Request-Id`).
- `TestResetRestartsCollectionWindowAndKeepsSpend`: reset did not restart `started_at`. It failed
  before the fix.

Pre-existing failures on Windows, with and without this change:
`TestValidateConfigSchema_ConfigSchemaFilePath`, `TestValidateConfigSchema_FileURL`, and the
repository-wide `npm run i18n:check`, which compares `/`-separated skip-list paths with
`\`-separated ones. On Linux (`node:26-bookworm`, Node 26.13.0) the repository-wide
`node scripts/i18nCheck.mjs` exits 0 with all 10 catalogs in parity with `en`.

End to end through a real gateway, with a deterministic mock upstream (300 requests, 12
concurrent, 25% streamed, sample rate 50%, judge and embeddings on): eight recorded runs on
windows/amd64 and linux/amd64, with and without the SQLite config store. In all eight the
strong candidate was `ready` and the weak one `not_ready`. The seven runs that promoted through
`run.sh` created the routing rule (HTTP 200), and the canary split on 200 follow-up requests was
within 3 standard deviations of the configured weight. A clean `scripts/setup.sh` build from
`ed62e4b` with the dashboard passed the same demo. The dashboard was also checked by hand in a
browser: scorecard, disagreements with paging and filters, the promote dialog's validation,
preview and caution, the created rule on **Routing Rules**, and reset.

## Provider harness

Recorded decision: this PR does not add a case to
`tests/e2e/api/collections/provider-harness.json`.

- The plugin is off by default and is registered only when an operator enables it. The shared
  harness profile (`tests/integrations/python/config.json`) does not enable it, so every
  existing harness case runs through an unchanged request path.
- With the plugin on, its only wire-visible effect is the `x-bf-shadow: sampled` response header
  on mirrored requests. Request and response bodies are never modified: `PostLLMHook` returns
  the response it receives and the stream-chunk hook passes chunks through. Candidate calls are
  internal and invisible to the client.
- Pinning that header in the harness would mean enabling the plugin in the shared profile, which
  would mirror harness traffic to candidate models and add live spend to every harness run, or
  adding a second profile for one header.
- The header is covered by Go tests (`TestShadowHeaderOverrides`,
  `TestShadowResponseHeaderAcrossContexts`) and was checked through a real gateway on a unary
  and a streaming response. The demo load generator also counts marked responses on every run.

This is a choice we are making, not an exemption: the header is wire-visible when the plugin
is on. If maintainers want the harness to pin it, we will add a case that sends
`x-bf-shadow: force` against a profile with the plugin enabled and asserts the header on unary
and streaming chat completions, plus its absence with `x-bf-shadow: off`.

Routes: `/v1/chat/completions` (unary and streaming) and the SDK integrations that map to chat
completions are mirrored. `/v1/responses`, embeddings, images and audio are not mirrored; the
plugin returns early for those request types.

## E2E

`tests/e2e/features/shadow-traffic/`: a `ShadowTrafficPage` page object on the page's
`data-testid` attributes, the shared base fixture, data factories, and specs for the
scorecard, live-update toggle, disagreements (filters and an expanded record), the promote
dialog (validation, preview, caution, rule creation visible on **Routing Rules**, ramping an
existing canary in place, and a second pair's canary at the next free priority), reset, and the
not-enabled state. Every routing rule a test creates is deleted in `afterEach`, and the
delete is asserted. The data tests seed their own shadow traffic when the store is empty and
skip when the plugin is off, so under `make run-e2e` (no shadow plugin in its config) only the
not-enabled test runs.

Result (windows/amd64, Playwright 1.57, against a gateway with the demo config): 11 passed and
1 skipped on two consecutive runs, the second from an empty store; against a gateway without the
plugin, the not-enabled test passed twice. The suite seeds with `x-bf-shadow: force`, so the
gateway under test needs `allow_force_header: true`. Running the data tests in CI needs a shadow-enabled
worker and the mock upstream in the E2E environment; that is a follow-up.

## Docs

- `docs/features/shadow-traffic.mdx`: overview, how it works (sequence diagram), verdicts, Web
  UI, API and `config.json` tabs, field reference, per-request headers, promotion, API reference,
  cost, privacy and overhead, and limitations. Linked from `docs/docs.json`.
- Two dashboard screenshots, `docs/media/ui-shadow-traffic.png` and
  `docs/media/ui-shadow-disagreements.png`, captured from the key-free demo.
- The page's `config.json` example, the README's and the demo's `config.json` validate against
  `transports/config.schema.json` with the gateway's `ValidateConfigSchema`.

## Limitations and follow-ups

- Chat completions only. Follow-up: the Responses API.
- Records are in memory on each node, optionally appended to a JSONL file that is compacted
  in place. In a cluster each node reports on its own traffic. Follow-up: a shared store
  through the config or log store.
- Candidates are compared with the primary, not with ground truth. Tool calls are compared,
  never executed, and multi-turn agents are evaluated one turn at a time. Only the first choice
  of an `n > 1` response is compared.
- The daily budget depends on prices: a model with neither a catalog price nor a manual override
  counts as free. Jobs reserve a moving-average cost before they start; the cap holds within
  that estimate.
- `daily_budget_usd` defaults to unlimited and `store_payloads` defaults to `true`. Open
  question for maintainers: whether either default should be stricter.
- `POST /api/shadow/promote` requires `ready` or an override reason. The dashboard dialog in this
  PR still creates the rule through the routing-rules API; follow-up: switch it to the promote
  endpoint and show live canary health.
- Canary health, the spend ledger and the rollout log are per node. The conflict check knows
  only provider, model and request type, so rules that depend on other request data are
  reported as warnings rather than refused.
- Request-path follow-up from the cost section: a gateway-level latency measurement.
- `transports/go.mod` carries a `replace` for `plugins/shadow` until the module is tagged.

## How to verify

```bash
cd plugins/shadow && go test -race ./... && go test -run xxx -bench . -benchmem
cd transports && go test -race -run 'Shadow|CELOverlap' ./bifrost-http/handlers/ ./bifrost-http/lib/
cd ui && npx vitest run lib/utils/shadow.test.ts && npm run typecheck && npm run i18n:check
cd examples/shadow-demo && BIFROST_BIN=/path/to/bifrost-http ./run.sh
```
