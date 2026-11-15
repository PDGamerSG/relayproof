# Test plan

What RelayProof tests, how to run the tests, and what is not tested yet. Paths are relative to the repository root. `bifrost-shadow/TESTING.md` is the log of what was actually run, on which platform and with what result. This page describes the suites themselves and what CI runs.

Most suites run inside the upstream clone that `bifrost-shadow/scripts/setup.sh` creates in `./bifrost/`. The script copies `plugins`, `transports`, `examples`, `docs`, `ui` and `tests` from `bifrost-shadow/` into the clone, applies the patches and writes a `go.work` (`bifrost-shadow/scripts/setup.sh:37-64`). A test file under `bifrost-shadow/plugins/shadow/` therefore runs from `bifrost/plugins/shadow/`.

## Test inventory

| Level | Tool | Location | What it covers | Runs in CI |
| --- | --- | --- | --- | --- |
| Unit and component | `go test` | `bifrost-shadow/plugins/shadow/*_test.go` | The plugin: 108 tests and 12 benchmarks in 9 files (detail below). | Yes, with `-race -count=2 -cover` |
| Unit (gateway API) | `go test` | `bifrost-shadow/transports/bifrost-http/handlers/shadow_test.go`, `bifrost-shadow/transports/bifrost-http/handlers/shadow_rollout_test.go`, `bifrost-shadow/transports/bifrost-http/handlers/shadow_ramp_test.go` | The `/api/shadow/*` handlers, promotion, rollback, ramps and rule conflicts: 30 tests. | Yes, with `-race -count=2` |
| Unit (config schema) | `go test` | `bifrost-shadow/patches/0002-config-schema.patch:22`, `bifrost-shadow/patches/0002-config-schema.patch:78` (the patch adds both tests to upstream's `transports/bifrost-http/lib/validator_test.go`, `bifrost-shadow/patches/0002-config-schema.patch:1`) | `TestValidateConfigSchema_ShadowPlugin` rejects malformed shadow configs. `TestValidateConfigSchema_ShadowCoversEverySetting` checks by reflection that every config field is in `config.schema.json` and nothing else is (`bifrost-shadow/TESTING.md:192-194`). | Yes, with `-race -count=2` |
| Unit (demo tools) | `go test` | `bifrost-shadow/examples/shadow-demo/frontdoor/main_test.go`, `bifrost-shadow/examples/shadow-demo/faultproxy/main_test.go`, `bifrost-shadow/examples/shadow-demo/loadgen/main_test.go` | The hosted front door (12 tests), the fault proxy (1) and `loadgen`'s readiness check (1). | Yes, without `-race` |
| End to end | `bash` | `bifrost-shadow/examples/shadow-demo/run.sh` | A real gateway with the plugin, a mock upstream and 300 requests, then the gated promotion, canary split, rollback and ramp. Every check is listed below. | Yes |
| Contract | `tsc`, `cmp` | `bifrost-shadow/api/client/shadowClient.ts` | Strict typecheck of the TypeScript client, and a byte-for-byte match with the site's copy. | Yes |
| Unit (dashboard) | Vitest | `bifrost-shadow/ui/lib/utils/shadow.test.ts` | The dashboard page's helpers: 32 cases in 12 `describe` blocks (verdict badges, model labels and keys, number formatting, savings tone, budget fraction, record query parameters, canary weight, canary rule placement and priority, ramping an existing canary, the create request, the not-enabled error, judge score delta). | No |
| End to end (dashboard) | Playwright | `bifrost-shadow/tests/e2e/features/shadow-traffic/` | The **Models > Shadow Traffic** page against a live gateway: 11 tests (detail below). | No |
| Type and build (dashboard) | `tsc`, Vite | the clone's `ui/` | `npm run build` runs while `setup.sh` builds the dashboard (`bifrost-shadow/scripts/setup.sh:72-75`). | No: CI sets `SKIP_UI=1` |
| Type and build (site) | `tsc`, Vite | `bifrost-shadow/site/` | `pnpm build` is `tsc --noEmit && vite build` (`bifrost-shadow/site/package.json:7-10`). The site has no unit tests. | No. Vercel runs `pnpm build` on deploy (`bifrost-shadow/site/vercel.json:4-5`). |
| Benchmarks | `go test -bench` | `bifrost-shadow/plugins/shadow/plugin_test.go:1334-1476`, `bifrost-shadow/plugins/shadow/ramp_test.go:584`, `bifrost-shadow/plugins/shadow/rollout_test.go:370-405` | Request-path cost of the hooks, unsampled and sampled, and the canary's per-response cost. Results are in `bifrost-shadow/TESTING.md:230-251`. | No |

### Go tests by file

| File | Tests | What they check |
| --- | --- | --- |
| `bifrost-shadow/plugins/shadow/plugin_test.go` | 40, plus 9 benchmarks | Mirroring and scoring of unary and streamed requests (text and tool calls); judge and embedding scoring; ineligible requests skipped; the `x-bf-shadow` header both ways, `force` ignored unless allowed, and the response header across the gateway's context split; sample rate; virtual key allow-list; candidate errors and a missing executor; the daily budget; a full queue that drops without blocking; a candidate equal to the primary; `store_payloads` off; stale captures swept; retried and duplicate request IDs; cleanup with jobs in flight; explicit zero thresholds; panics in pricing; MCP isolation; `extra_params`; streamed refusals; embedding cost; verdicts; canary rules, including wildcard sources; persistence and reset; the ring buffer and filters; concurrent traffic. |
| `bifrost-shadow/plugins/shadow/readiness_test.go` | 9 | Wrong JSON values are never `ready` without a judge; a failing judge cannot produce `ready`; the judge error rate withholds a verdict; tool selection is a required check; tool diffs; the order of pass signals; exact matching ignores case and whitespace; exports read one snapshot; the `quality_fallback` setting. |
| `bifrost-shadow/plugins/shadow/rollout_test.go` | 14, plus 2 benchmarks | The canary guard: rollback on live errors, a shared outage tolerated, a single unlucky failure ignored, a canary changed meanwhile skipped, non-chat failures ignored, `max_error_rate: 0` kept, the latency limit, rollback when the verdict turns `not_ready`, override canaries, guard off only reports, streams counted once, canaries surviving a plugin reload, per-pair scorecards. |
| `bifrost-shadow/plugins/shadow/ramp_test.go` | 13, plus 1 benchmark | Ramps: step by step to completion, an unhealthy step rolled back, holding without auto rollback, an operator promotion replacing or cancelling a ramp, a changed canary skipped, a failing or missing hook, a restart mid-ramp, `PlanRamp` validation, ramp events, no `ramp` key without a ramp, concurrent traffic, responses from before a step ignored, a failed rollout-log save still applied. |
| `bifrost-shadow/plugins/shadow/ledger_test.go` | 6 | The daily budget survives a plugin reload and a restart with `persist_path`; seeding from today's records; a corrupt ledger file is an error; reservations; concurrent use. |
| `bifrost-shadow/plugins/shadow/compare_test.go` | 9 | Token F1, tool-call equality, JSON shape, answer comparison, cosine similarity, the Wilson lower bound, percentiles, answer parsing, truncation. |
| `bifrost-shadow/plugins/shadow/judge_test.go` | 7 | Judge reply parsing (positions mapped back, code fences, garbage rejected), randomized slots, `max_tokens` and `effort`, transcript trimming. |
| `bifrost-shadow/plugins/shadow/api_test.go` | 5 | Record limit default and clamp; canary rule weight checks, routable targets, stable names and priority. |
| `bifrost-shadow/plugins/shadow/store_test.go` | 5 | JSONL compaction while appending and on open, a torn last line, reset and add staying consistent. |
| `bifrost-shadow/transports/bifrost-http/handlers/shadow_test.go` | 10 | 404 when the plugin is not loaded; summary, records, one record, reset; the canary-rule preview with bad weights and priorities; CSV cells that a spreadsheet would run as formulas. |
| `bifrost-shadow/transports/bifrost-http/handlers/shadow_rollout_test.go` | 11 | Promotion creates the canary and records evidence, refuses a not-ready candidate, merges a second candidate into the same rule, detects conflicting rules, dry run and validation, picks a free priority; rollback, including a rule removed by hand; the guard uses the rollback hook; `TestCELOverlap`; rollouts and export. |
| `bifrost-shadow/transports/bifrost-http/handlers/shadow_ramp_test.go` | 9 | Promotion with a ramp, ramp validation, unchanged answers without a ramp, cancelling or replacing a ramp, the ramp hook edits only the existing rule, the guard uses the ramp hook, a share another ramp still needs is refused, a disabled rule holds the ramp, an unsaved rollout log is a warning. |
| `bifrost-shadow/examples/shadow-demo/frontdoor/main_test.go` | 12 | Route allowlist; token attached and caller credentials dropped; incident validation and self-clearing; bursts one at a time; the canary janitor; the POST limit; scorecard reset after the last incident; the daily cap over every kind of request; questions forced into the shadow with their request ID; the per-address question limit; configurable incident models; a promote body with `ramp` reaching the gateway unchanged. |
| `bifrost-shadow/examples/shadow-demo/faultproxy/main_test.go` | 1 | Requests forwarded unchanged, incidents injected. |
| `bifrost-shadow/examples/shadow-demo/loadgen/main_test.go` | 1 | `checkReady`, which backs `-require-ready`. |

Counts are the `func Test...` and `func Benchmark...` declarations in each file. The plugin total (108) and the handler total (30) match the last recorded run (`bifrost-shadow/TESTING.md:34`).

### Playwright suite for the dashboard

`bifrost-shadow/tests/e2e/features/shadow-traffic/shadow-traffic.spec.ts` uses a page object on `data-testid` selectors and compares the page with the live API (`bifrost-shadow/TESTING.md:322-326`).

| Group | Tests | Where |
| --- | --- | --- |
| Scorecard | Counter tiles and a verdict per candidate; pause and resume live updates | `bifrost-shadow/tests/e2e/features/shadow-traffic/shadow-traffic.spec.ts:250-369` |
| Disagreements | Switch the weak candidate between disagreements and errors; expand a record to both answers and the judge's verdict | `bifrost-shadow/tests/e2e/features/shadow-traffic/shadow-traffic.spec.ts:371-468` |
| Promote to canary | Share validation and preview rebuild; caution for a candidate that is not ready; create a rule and find it on **Routing Rules**; update the pair's existing rule in place instead of adding a second; give a second pair the next free priority | `bifrost-shadow/tests/e2e/features/shadow-traffic/shadow-traffic.spec.ts:470-744` |
| Reset | Counters cleared, empty scorecard | `bifrost-shadow/tests/e2e/features/shadow-traffic/shadow-traffic.spec.ts:746-804` |
| Without the plugin | The page explains how to enable it | `bifrost-shadow/tests/e2e/features/shadow-traffic/shadow-traffic.spec.ts:806-834` |

The data tests skip when `GET /api/shadow/summary` answers 404, and the not-enabled test skips otherwise (`bifrost-shadow/tests/e2e/features/shadow-traffic/shadow-traffic.spec.ts:226-235`, `bifrost-shadow/tests/e2e/features/shadow-traffic/shadow-traffic.spec.ts:806-810`). With too little data, `beforeAll` seeds traffic with `x-bf-shadow: force`, so the gateway needs `allow_force_header: true` (`bifrost-shadow/TESTING.md:336-337`, `bifrost-shadow/TESTING.md:354-356`). Every routing rule a test creates is deleted afterwards, and the delete is asserted (`bifrost-shadow/tests/e2e/features/shadow-traffic/shadow-traffic.spec.ts:242-248`).

### Checks in the key-free demo (`run.sh`)

`run.sh` runs with `set -euo pipefail` (`bifrost-shadow/examples/shadow-demo/run.sh:12`), so an unset variable or a failing command (the Go build, `loadgen`) also stops it with a non-zero status. These are its explicit checks, in order. Each one prints the message and exits 1.

| # | Step | Fails when | Message | Line |
| --- | --- | --- | --- | --- |
| 1 | Start | `BIFROST_BIN` is unset | "set BIFROST_BIN to a bifrost-http binary built with the shadow plugin" (stops via `${VAR:?}`) | `bifrost-shadow/examples/shadow-demo/run.sh:20` |
| 2 | Gateway up | `GET /health` has not answered after 60 tries, one a second | "gateway did not become healthy", plus the last 30 lines of `gateway.log` | `bifrost-shadow/examples/shadow-demo/run.sh:49-53` |
| 3 | Readiness gate | `loadgen -report -require-ready openai/gpt-4o-mini` exits non-zero (it exits 2 when the verdict is not `ready`) | "not promoting; collect more evidence first, for example REQUESTS=600 [path to run.sh]" | `bifrost-shadow/examples/shadow-demo/run.sh:59-64`, `bifrost-shadow/examples/shadow-demo/loadgen/main.go:69-73` |
| 4 | Gated promotion | Promoting `openai/llama-3.1-8b` does not answer 409 | "expected 409: a candidate that is not ready must not be promoted without an override reason" | `bifrost-shadow/examples/shadow-demo/run.sh:71-77` |
| 5 | Promotion | Promoting `openai/gpt-4o-mini` answers 300 or higher | "promotion failed (it needs the config store and the routing plugin)" | `bifrost-shadow/examples/shadow-demo/run.sh:85-91` |
| 6 | Canary split | Of 200 live requests, the count served by `gpt-4o-mini` is outside 3 standard deviations of the weight (default 10%) | "canary split is outside the expected range" | `bifrost-shadow/examples/shadow-demo/run.sh:112-122` |
| 7 | Automatic rollback | After a 60% incident on `gpt-4o-mini`, no `auto_rollback` event appears within up to 9 rounds (8 extra bursts of 50 requests) | "the canary guard did not roll back" | `bifrost-shadow/examples/shadow-demo/run.sh:128-156` |
| 8 | After rollback | Any of the next 100 requests is served by `gpt-4o-mini` | "traffic still reaches the rolled-back candidate" | `bifrost-shadow/examples/shadow-demo/run.sh:160-167` |
| 9 | Ramped promotion | Promoting again with `{"steps":[0.1,0.5,1],"min_requests":10,"hold_seconds":2}` answers 300 or higher | "ramped promotion failed: HTTP [status] [body]" | `bifrost-shadow/examples/shadow-demo/run.sh:170-180` |
| 10 | Ramp progress | The ramping canary disappears from `/api/shadow/rollouts` | "the ramping canary disappeared" | `bifrost-shadow/examples/shadow-demo/run.sh:187-197` |
| 11 | Ramp end | The ramp is not complete after 60 rounds of 40 requests | "the ramp did not complete" | `bifrost-shadow/examples/shadow-demo/run.sh:198-201` |
| 12 | Full cutover | Fewer than 50 of the next 50 requests are served by `gpt-4o-mini` | "expected a full cutover at the ramp's last step" | `bifrost-shadow/examples/shadow-demo/run.sh:202-207` |

Not checked, only printed: the dry-run plan (`bifrost-shadow/examples/shadow-demo/run.sh:79-82`), the canary's health (`bifrost-shadow/examples/shadow-demo/run.sh:124-126`), the failures during the incident (`bifrost-shadow/examples/shadow-demo/run.sh:128-132`) and the rollout log (`bifrost-shadow/examples/shadow-demo/run.sh:209-215`).

Sampling, the judge's answer order, the canary split and the mock's incident failures are random (`bifrost-shadow/plugins/shadow/main.go:394`, `bifrost-shadow/plugins/shadow/worker.go:331`, `bifrost-shadow/examples/shadow-demo/run.sh:116`, `bifrost-shadow/examples/shadow-demo/mockupstream/main.go:155`), so the numbers change from run to run, and checks 3, 6 and 7 can fail by chance. `bifrost-shadow/TESTING.md:228` records how an earlier mock setting left one run `promising`, and why the mock's error rate was lowered and the readiness gate (check 3) added.

## How to run

From the repository root. The Go commands mirror CI (`.github/workflows/shadow.yml:28-46`). They need Go 1.27.3 or newer and a C compiler. The demo needs `python3` and `curl`, and ports 8080 and 18080 unless you set `PORT` and `MOCK_ADDR`.

```bash
# Clone upstream at the pinned commit, overlay, patch, quick tests, build the gateway.
# Without SKIP_UI=1 it also builds the dashboard, which the dashboard tests below need.
SKIP_UI=1 bifrost-shadow/scripts/setup.sh

# Plugin tests (as CI)
(cd bifrost/plugins/shadow && go test -race -count=2 -cover ./...)

# Gateway handler and schema tests (as CI)
(cd bifrost/transports && go test -race -count=2 -run 'Shadow|CELOverlap' ./bifrost-http/handlers/ ./bifrost-http/lib/)

# Vet, and the demo tools' tests (as CI)
(cd bifrost/plugins/shadow && go vet ./...)
(cd bifrost/transports && go vet ./bifrost-http/handlers/ ./bifrost-http/lib/ ./bifrost-http/server/)
(cd bifrost/examples/shadow-demo && GOWORK=off go vet ./... && GOWORK=off go test ./...)

# Key-free demo through a real gateway (as CI). BIFROST_BIN must be absolute.
BIFROST_BIN="$PWD/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/run.sh
# If 8080 or 18080 is taken:
PORT=8180 MOCK_ADDR=127.0.0.1:18180 BIFROST_BIN="$PWD/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/run.sh

# TypeScript client (as CI)
npx --yes -p typescript@5.6.3 tsc --noEmit --strict --target es2022 --module esnext \
  --moduleResolution bundler --lib es2022,dom --noUnusedLocals --noUnusedParameters \
  bifrost-shadow/api/client/shadowClient.ts
cmp bifrost-shadow/api/client/shadowClient.ts bifrost-shadow/site/src/live/shadowClient.ts

# Benchmarks (not in CI)
(cd bifrost/plugins/shadow && go test -run '^$' -bench . -benchmem -count=5)

# Site typecheck and build (not in CI)
(cd bifrost-shadow/site && pnpm install && pnpm build)

# Dashboard helpers and types (not in CI; needs setup.sh without SKIP_UI=1)
(cd bifrost/ui && npx vitest run lib/utils/shadow.test.ts)
(cd bifrost/ui && npm run typecheck)
```

The demo-tools step in CI runs without the race detector. The verification log also ran it with `-race` (`bifrost-shadow/TESTING.md:16`): `(cd bifrost/examples/shadow-demo && GOWORK=off go test -race ./...)`.

The dashboard commands come from `bifrost-shadow/TESTING.md:175-178`. The Playwright suite needs a gateway built with the dashboard and the plugin, a config like `bifrost-shadow/examples/shadow-demo/gateway/config.json` (it sets `allow_force_header: true`), and upstream's Playwright config without its `globalSetup` (`bifrost-shadow/TESTING.md:342-345`). Under upstream's `make run-e2e`, whose config has no shadow plugin, only the not-enabled test runs (`bifrost-shadow/TESTING.md:338-340`). The exact Playwright command is not recorded in the repository.

## CI

One workflow, `.github/workflows/shadow.yml`, named `bifrost-shadow`.

**Triggers** (`.github/workflows/shadow.yml:3-9`):

- `push` to `main`, when the commit touches `bifrost-shadow/**`, `.github/workflows/shadow.yml`, `render.yaml` or `.dockerignore`;
- `pull_request` touching the same paths;
- `workflow_dispatch` (manual).

A new run cancels a running one for the same ref (`.github/workflows/shadow.yml:11-13`). Changes outside those paths, such as the repository README or `docs/`, start no run.

**Job `backend`**, "Plugin, gateway API and key-free demo", on `ubuntu-latest` with a 45-minute limit (`.github/workflows/shadow.yml:16-46`):

1. Check out, and install Go `1.27.x` without the module cache.
2. `SKIP_UI=1 bifrost-shadow/scripts/setup.sh`: clone upstream at `ed62e4b`, overlay, apply the five patches, write `go.work`, run the plugin tests and the handler and schema tests once without `-race` (`bifrost-shadow/scripts/setup.sh:80-82`), and build the gateway.
3. Plugin tests: `go test -race -count=2 -cover ./...` in `bifrost/plugins/shadow`. Coverage is printed. No minimum is enforced.
4. Handler and schema tests: `go test -race -count=2 -run 'Shadow|CELOverlap' ./bifrost-http/handlers/ ./bifrost-http/lib/` in `bifrost/transports`.
5. Vet: the plugin, the gateway's `handlers`, `lib` and `server` packages, then `GOWORK=off go vet ./... && GOWORK=off go test ./...` for the demo tools.
6. The key-free demo: `BIFROST_BIN="$PWD/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/run.sh`.

**Job `client`**, "TypeScript client", on `ubuntu-latest` with a 10-minute limit and Node 22 (`.github/workflows/shadow.yml:48-60`):

1. Strict typecheck of `bifrost-shadow/api/client/shadowClient.ts` with `typescript@5.6.3`.
2. `cmp` of `bifrost-shadow/api/client/shadowClient.ts` with `bifrost-shadow/site/src/live/shadowClient.ts`.

CI does not run the dashboard's Vitest or Playwright suites, its typecheck, its i18n check or its build (`SKIP_UI=1`). It does not build or typecheck the site, run the benchmarks, build the Docker image in `bifrost-shadow/deploy/`, or start `dev.sh`.

## Not tested yet

- **The dashboard in CI.** The Vitest helpers, the Playwright suite, `npm run typecheck`, the i18n check and the dashboard build ran only by hand (`bifrost-shadow/TESTING.md:175-178`, `bifrost-shadow/TESTING.md:320-366`). A change under `bifrost-shadow/ui/` or `bifrost-shadow/tests/` that breaks them still passes CI.
- **The site.** It has no unit tests and CI does not typecheck or build it. A type error first shows up in the Vercel build (`bifrost-shadow/site/vercel.json:4-5`). The statistics it reimplements (`bifrost-shadow/site/src/lib/stats.ts`, `bifrost-shadow/site/src/live/policy.ts`, `bifrost-shadow/site/src/live/judgeStats.ts`) and the config builder that mirrors the plugin's validation (`bifrost-shadow/site/src/live/configBuilder.ts`) have no tests that compare them with the Go code. The site README asks for manual updates when the plugin's rules change (`bifrost-shadow/site/README.md:64-78`).
- **The live console in a browser.** No automated browser test covers `/live`. Its checks are manual entries in the log (`bifrost-shadow/TESTING.md:54-72`). Signing in from the hosted page to a gateway on `localhost` was not verified in a browser (`bifrost-shadow/TESTING.md:71`).
- **The client against a live gateway.** CI typechecks the client but never calls a gateway with it. The 14-check run against a gateway was manual (`bifrost-shadow/TESTING.md:89`), and so was the field-by-field check of `bifrost-shadow/api/openapi.yaml` against live responses (`bifrost-shadow/TESTING.md:88`).
- **Two TypeScript versions.** CI checks the client with TypeScript 5.6.3 (`.github/workflows/shadow.yml:58`), while the site compiles the same file with TypeScript `^7.0.2` (`bifrost-shadow/site/package.json:23`). Only the site's compiler is tested for the copy the console ships, and only on Vercel.
- **The deployment.** The Docker image, the entrypoint's two modes and the Render and Vercel setup are not built or exercised in CI. The hosted checks are manual (`bifrost-shadow/TESTING.md:36-72`).
- **Mock upstream and dataset.** `bifrost-shadow/examples/shadow-demo/mockupstream/` and `bifrost-shadow/examples/shadow-demo/dataset/` have no test files. `run.sh` exercises them only indirectly.
- **Race detector on the demo tools.** CI runs `go test ./...` there without `-race` (`.github/workflows/shadow.yml:43`).
- **Performance.** Benchmarks and the gateway-level latency measurement are manual and recorded on one machine each (`bifrost-shadow/TESTING.md:116-133`, `bifrost-shadow/TESTING.md:230-251`). Nothing in CI flags a regression.
- **A known issue with no fix or test.** On a plugin reload, two record stores briefly share the same `persist_path`, and records appended in that window can go to the replaced file (`bifrost-shadow/TESTING.md:134-138`).
- **Windows.** Two upstream schema tests and the repository-wide i18n check fail on Windows, with or without this change (`bifrost-shadow/TESTING.md:196-204`). CI runs on Linux only.
