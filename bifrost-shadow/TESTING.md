# Verification log

What was run to check Bifrost Shadow, on which platform, and what came back. Every result
below was observed, not estimated. Base: `maximhq/bifrost@ed62e4b`, Go 1.27.4, Node 26.

## Round 2: review fixes, promotion and the canary guard (13 November 2026)

macOS arm64 (10 cores), Go 1.27.3, Node 26.8.1, same pinned upstream. Everything below was run
after the last code change of the round.

| Suite | Command | Result |
|---|---|---|
| Plugin (93 top-level tests) | `cd plugins/shadow && go test -race -count=2 -cover ./...` | pass, 89.0% statement coverage |
| Gateway handlers (21 tests) | `cd transports && go test -race -count=2 -run 'Shadow\|CELOverlap' ./bifrost-http/handlers/` | pass |
| Config schema (2 tests) | same command, `./bifrost-http/lib/` | pass (the coverage test now also checks `CanaryConfig`) |
| Vet | `go vet` on the plugin, `handlers`, `lib`, `server`; demo `GOWORK=off go vet ./... && go test ./...` | clean, pass |
| TypeScript client | `tsc --noEmit --strict --noUnusedLocals --noUnusedParameters api/client/shadowClient.ts` | clean |
| Clean-room build | `SKIP_UI=1 scripts/setup.sh <fresh checkout of ed62e4b>`: overlay, all five patches, plugin and handler tests, gateway build | pass: all five patches applied, tests passed, gateway built |
| Key-free demo | `BIFROST_BIN=… examples/shadow-demo/run.sh` (twice) | exit 0, 1 min 41 s |
| API contract | a gateway with demo traffic; every route's response (summary, records, record, 404 error, canary-rule, promote 200 / 409 / dry run, rollouts, rollback, export) checked field by field against `api/openapi.yaml` | 13 of 13 shapes match |
| Client end to end | `api/client/shadowClient.ts` against the same gateway: status, auth failure, summary, paging, record, disagreements, refused promotion, plan, promote, polling, rollback, 404 on a second rollback, CSV and JSON export | 14 of 14 checks pass |

Demo run 2 (the first run's guard bug is in the table below):

```
openai/gpt-4o-mini   146  100.0%  lower 97.4%  errors 0.0%  READY
openai/llama-3.1-8b  146   67.1%  lower 59.1%  errors 2.7%  NOT READY
promote llama-3.1-8b       HTTP 409: not_ready - agreement 67.1% is below 90%
dry run gpt-4o-mini        create, targets gpt-4o 0.9 / gpt-4o-mini 0.1, no warnings
promote gpt-4o-mini        HTTP 200 create
split                      gpt-4o-mini served 20 of 200 requests (expected 20)
canary health              healthy: live error rate 0.0% within 5.0% over 20 requests
incident (60% 503s)        gpt-4o-mini served 6 of 150 requests, 5 failed
canary guard               rolled back: live error rate 19.2% (95% lower bound 8.5%) exceeds 5.0%
after rollback             gpt-4o-mini served 0 of 100 requests, 0 failed
```

The gateway binary from the clean-room build passed the same `run.sh`: gpt-4o-mini ready (lower
bound 97.7%), llama-3.1-8b refused with `409` (65.6%), 19 of 200 requests on the canary, rolled
back during the incident at a live error rate of 21.4% (lower bound 10.2%), 0 of 100 afterwards.

Multi-candidate promotion on the real gateway (the review's routing reproduction, now fixed):
promoting `gpt-4o-mini` at 50% and then `llama-3.1-8b` at 20% (with an override reason) left one
routing rule, `Shadow canary: openai/gpt-4o -> openai/gpt-4o-mini, openai/llama-3.1-8b`, with
targets gpt-4o-mini 0.5, gpt-4o 0.3, llama-3.1-8b 0.2. Before, the second rule was created and
never served a request.

**Gateway-level latency, plugin off and on.** The review asked for a measurement beyond
microbenchmarks. Same machine, mock upstream at zero latency (so the gateway's own cost shows),
request logging off, 3,000 requests at 32 concurrent, 25% streamed, after a 300-request warm-up,
fresh gateway per run, two alternating rounds:

| Configuration | Throughput (round 1 / 2) | Client p50 | Client p95 |
|---|---|---|---|
| Plugin off | 6,881 / 6,652 req/s | 4 / 4 ms | 10 / 11 ms |
| Plugin on, sample rate 10% | 5,986 / 4,446 req/s | 4 / 6 ms | 12 / 17 ms |
| Plugin on, sample rate 100% (most jobs dropped by the full queue) | 5,836 / 5,063 req/s | 4 / 5 ms | 12 / 14 ms |

This is an upper bound on the cost, not the request-path cost alone: the sampled requests'
candidate, judge and embedding calls (four extra upstream calls each) ran through the same
gateway, against the same mock, on the same 10 cores as the load generator. Round-to-round
spread is large (round 2 at 10% was the slowest run), so treat the figures as one laptop's
measurement. A deployment with remote providers spends this background work waiting on the
network rather than on local CPU.

Known and not fixed: on a plugin reload the gateway starts the new instance before cleaning up
the old one, so for a moment two record stores hold the same `persist_path`. If the old one
compacts the file in that window, records it appends afterwards go to the replaced file. This
predates this round (the stores have always been per instance); the spend ledger and rollout
book are shared and not affected.

After the review fixes: plugin and gateway suites pass with `-race`, and `run.sh` passed again on
the rebuilt gateway (rolled back at a live error rate of 19.0%, lower bound 7.7%). CI on GitHub
(Linux) passed every step, including the full demo.

Benchmarks added this round (`-count=3`, macOS arm64): `PostLLMHookCanaryOtherModel` 14 ns,
`PostLLMHookCanarySourceModel` 25 ns, both 0 allocations; `PostLLMHookNoCapture` stays 2.2 ns.

Fixed this round:

| Found by | Problem | Fix |
|---|---|---|
| Project review, finding 1 | Reloading the plugin (any settings update) or restarting the gateway reset today's spend, lifting the daily budget | Process-wide spend ledger per persist path, saved to `<persist_path>.spend.json`; jobs reserve their expected cost first. `TestDailyBudgetSurvivesPluginReload` (memory and persisted), `TestDailyBudgetSurvivesRestartWithPersistPath`, `TestLedgerSeededFromTodaysRecords`, `TestCorruptLedgerFileIsAnError`, `TestLedgerReservations` |
| Project review, finding 2 | A second canary for the same source was created but unreachable (the routing engine stops at the first matching rule) | Server-side promotion merges candidates into one rule per source and refuses rules an earlier rule would shadow. `TestShadowPromoteSecondCandidateSharesTheSameRule` checks the effective traffic shares; confirmed on a real gateway above |
| Project review, finding 3 | Matching JSON keys passed a pair whatever the values, and a judge that failed on every pair still produced `ready` | JSON structure and tool selection are required gates, never a pass; a failed judge leaves the pair unscored; judge error rate above `max_judge_error_rate` withholds the verdict; lexical overlap is opt-in. `TestWrongJSONValuesAreNeverReadyWithoutAJudge` and `TestFailingJudgeCannotProduceAReadyVerdict` reproduce the review's 40-pair cases |
| Project review, finding 4 | Quick start pointed at the wrong directory and a relative binary path | README uses paths from the repository root and an absolute `BIFROST_BIN` |
| First demo run | The canary guard rolled back after 1 failure in 17 candidate requests (5.9% raw against 5%) | The guard uses the 95% Wilson lower bound of the live error rate. `TestCanaryGuardIgnoresASingleUnluckyFailure` |
| API contract check | A candidate promoted with an override reason (not ready by definition) was rolled back by the verdict rule within one guard tick | Override canaries are guarded on live health only. `TestCanaryGuardRespectsAnOverride` |
| Independent code review | The guard judged a canary, then rolled it back and recorded the event outside the promotion lock: a ramp or re-promotion in between could be undone on stale evidence or left live but unwatched | Check, rule edit and record run under one lock; a changed canary is skipped (`ErrCanaryChanged`). `TestCanaryGuardSkipsACanaryChangedMeanwhile` |
| Independent code review | Rollback deleted the stored rule before removing it from the routing engine; if the engine call failed, a retry found no rule and reported success while traffic still flowed | Engine first, then the store |
| Independent code review | A rule matching only streamed chat requests counted as matching every request and refused promotion | Both request types must match for a refusal; one is a warning. `TestCELOverlap` |
| Independent code review | Failed embedding or Responses calls for the source model's name counted as canary errors | Only chat request types count. `TestCanaryIgnoresNonChatFailures` |
| Independent code review | A panic while scoring dropped the already-billed candidate cost from the budget | Cost is recorded right after the call |
| Independent code review | `canary.max_error_rate: 0` was replaced by the default; export paging could repeat or skip records while new ones arrived | Pointer field keeps 0 (`TestCanaryMaxErrorRateZeroIsKept`); export reads one snapshot (`TestAllRecords`) |

## Unit and component tests

| Suite | Command | Platform | Result |
|---|---|---|---|
| Plugin (64 tests) | `cd plugins/shadow && go test -count=3 ./...` | windows/amd64 | pass |
| Plugin under CPU load | four test binaries at once, each `-test.count=3 -test.cpu=1,4` | windows/amd64, 32 threads | pass (after the queue-test fix below) |
| Plugin, race detector | `go test -race -count=2 ./...` | linux/amd64 (golang:1.27-bookworm) | pass (rerun after the core fixes below) |
| HTTP handler (9 tests) | `cd transports && go test -race -count=2 -run Shadow ./bifrost-http/handlers/` | linux/amd64 | pass |
| Config schema (2 tests) | `go test -run TestValidateConfigSchema_Shadow ./bifrost-http/lib/` | windows/amd64, linux/amd64 | pass |
| Vet | `go vet` on `plugins/shadow`, `bifrost-http/server`, `handlers`, `lib` | windows/amd64 | clean |
| Demo tools | `cd examples/shadow-demo && GOWORK=off go vet ./... && go test ./...` | windows/amd64 | pass (`checkReady`) |
| Dashboard helpers (31 tests) | `cd ui && npx vitest run lib/utils/shadow.test.ts` | windows/amd64, linux/amd64 | pass |
| Dashboard types | `cd ui && npm run typecheck` | windows/amd64 | pass |
| Dashboard strings | `node scripts/i18nCheck.mjs app/workspace/shadow components/navigation lib/utils/shadow.ts lib/store/apis/shadowApi.ts lib/types/shadow.ts` | windows/amd64 | exit 0, all 10 translated catalogs in parity with `en` |
| Dashboard build | `cd ui && npm run build` | windows/amd64, linux/amd64 | pass |

What the plugin tests cover: sampling and per-experiment rates, the `x-bf-shadow` header in
both directions (including the gateway's parent/child context split), streaming accumulation
up to the final chunk, cache hits and failed primaries being skipped, candidate equal to the
served model being skipped, candidate errors and panics recorded as failures, judge parsing
with randomized order, budget exhaustion, queue overflow, stale-capture and marker sweeping,
JSONL persistence with torn lines, reset (including the collection window and kept spend),
verdicts and Wilson bounds, canary rule generation (including wildcard sources, weight
bounds and priority), and pricing overrides. Since the code review below they also cover MCP
isolation of shadow calls, the opt-in force header, request IDs shared by concurrent requests,
streamed refusals, `extra_params`, explicit zero thresholds, panics in pricing and storage,
shutdown with jobs in flight, and compaction of the JSONL file.

The schema tests reject twelve malformed configs and check by reflection that every field of
`shadow.Config`, `Thresholds`, `JudgeConfig` and `EmbeddingConfig` is in `config.schema.json`
and nothing else is.

Pre-existing upstream failures on Windows, with and without this change, not related to it:

- `TestValidateConfigSchema_ConfigSchemaFilePath` and `TestValidateConfigSchema_FileURL`
  (Windows path escaping in JSON and `file://` URLs).
- The repository-wide `npm run i18n:check` exits 1 on Windows because its skip lists compare
  `/`-separated paths with `\`-separated ones; it flags only files on its own skip list. The
  scoped run above, and a run with separators normalized, exit 0. On Linux
  (`node:26-bookworm`, Node 26.13.0) the repository-wide `node scripts/i18nCheck.mjs` exits 0,
  all 10 catalogs `ok`.

## Bugs found by testing, then fixed

| Found by | Problem | Fix |
|---|---|---|
| End-to-end run through the real gateway | `x-bf-shadow: sampled` never appeared: the gateway runs LLM hooks on a child of the transport context, so a context flag set in `PreLLMHook` was invisible to the response-headers hook | Track sampled request IDs in the plugin, matched through the `X-Bifrost-Request-Id` header; regression test `TestShadowResponseHeaderAcrossContexts` reproduces the split and failed before the fix |
| `go test -race` | `store.len()` read the ring-buffer cursor without the lock while a worker inserted | Read lock in `len()`, `lenLocked()` for callers that hold it |
| Windows test run | Resetting the JSONL file failed with "Access is denied" while it was open | Close, then reopen with `O_TRUNC` |
| End-to-end run with a config store | Demo traffic got HTTP 401/403 (inference auth on, `/api` locked behind a setup token) | Demo config and scripts handle both |
| Dashboard check of Reset | Reset zeroed the counters but `started_at` ("Collecting since") kept the plugin start time | `started_at` is an atomic restarted by `Reset`; `TestResetRestartsCollectionWindowAndKeepsSpend` failed before the fix. Today's spend is kept on purpose (a reset must not lift the daily budget) and the dialog and docs now say so |
| Dashboard check of disagreements | The judge's reason says "response A is incorrect" in a random order, so it could read as blaming the primary | The record view states which label the candidate had (`candidate_shown_first`); checked against all 42 judged failures in one run: 42 consistent |
| Code review | With `store_payloads: false` the primary answer was blanked before scoring, so every pair was compared with an empty answer | Only what is stored is left out; `TestShadowStorePayloadsOff` |
| Code review | MCP adds its tools before plugin hooks run, so the replay carried them, and MCP's agent loop could run a tool on a shadow call | Empty MCP allow-lists on every internal call, MCP-added tools dropped from the replay; `TestInternalContextExcludesMCP`, `TestSnapshotDropsMCPInjectedTools` |
| Code review | Any caller could send `x-bf-shadow: force`; shadow calls skip governance, so that was unbilled spend on demand | `allow_force_header`, off by default; `TestShadowForceHeaderIgnoredUnlessAllowed` |
| Code review | Request IDs are caller-supplied: two in-flight requests sharing one could pair one prompt with the other's answer | Captures are claimed with a per-request token; `TestDuplicateRequestIDsNeverCrossPair`, `TestSharedRequestIDStressKeepsActiveBalanced` |
| Code review | A threshold set to `0` fell back to its default | Explicitly set fields are tracked while decoding; `TestThresholdsHonourExplicitZero` |
| Code review | A streamed refusal compared as an empty answer; `extra_params` never reached the candidate | `TestShadowStreamingAccumulatesRefusal`, `TestCandidateReceivesExtraParams` |
| Code review | A panic in pricing escaped the worker's recover, a panic while storing could account a job twice, and shutdown recorded cancelled calls as candidate errors | Recover first, finish once, a worker-level recover, cancelled jobs dropped; `TestPanickingPriceFuncIsRecordedOnce`, `TestFinishRunsOncePerJob`, `TestCleanupDropsCancelledJobs` |
| Code review | Embedding cost was lost when the returned vectors could not be compared | `TestEmbeddingCostKeptWhenVectorsUnusable` |
| Code review | `persist_path` grew without bound and was replayed in full on start; a torn last line swallowed the next record | Rewritten with the newest `max_records` once it passes twice that; `TestStoreCompactsPersistFileWhileAppending`, `TestStoreCompactsOversizedFileOnOpen`, `TestStoreTornLastLineDoesNotSwallowNextRecord` |
| Code review | Switching pairs could briefly show the previous pair's records or promote form | The sheet list and the form are keyed by pair and read only current data |
| Dashboard E2E | The docs said a candidate could be promoted again to raise its share, but every canary rule had priority 10, so the second promote got HTTP 409 | The API takes `priority`; the dialog picks a free priority and updates an existing canary rule in place |
| Test runs under CPU load | `TestShadowQueueFullDropsWithoutBlocking` failed when the worker had not yet taken the first job | The test waits until the worker holds the first job |
| Repeated demo runs | With the mock's gpt-4o-mini at 4% wrong answers, its lower bound was 89.8-91.8% across five runs against the 90% threshold; one run showed `promising`, and `run.sh` would have promoted it anyway | Mock set to 2%; `run.sh` now promotes only a `ready` candidate (`loadgen -report -require-ready`) |

## Benchmarks

`cd plugins/shadow && go test -run '^$' -bench . -benchmem -count=5` (windows/amd64, 32 threads), median of the
five runs:

| Benchmark | ns/op | B/op | allocs/op |
|---|---|---|---|
| PreLLMHookNotEligible | 67.8 | 0 | 0 |
| PreLLMHookEligibleNotSampled | 98.6 | 0 | 0 |
| PreLLMHookEligibleNotSampledParallel | 54.0 | 0 | 0 |
| UnsampledWhileActive | 160.1 | 0 | 0 |
| PostLLMHookNoCapture | 2.9 | 0 | 0 |
| ResponseHeadersHookNotSampled | 2.2 | 0 | 0 |
| StreamChunkHook | 0.37 | 0 | 0 |
| StreamChunkInterceptorOnePlugin | 180.9 | 240 | 2 |
| SampledRequest | 9,560 | about 3,400 | 33 |

`StreamChunkInterceptorOnePlugin` mirrors the gateway's per-chunk interceptor with only this
plugin registered; its 240 bytes and 2 allocations are the interceptor's scope wrapper, which
any transport plugin pays. `StreamChunkHook` is this plugin's own share. `SampledRequest` went
from 7,890 ns and 31 allocations to 9,560 ns and 33 after the snapshot started filtering MCP
tools and carrying `extra_params`; only sampled requests pay it.

## End to end through a real gateway

Mock upstream + gateway built from this change + `loadgen`, 300 requests, 12 concurrent,
25% streamed, sample rate 50%, judge and embeddings on. Runs 1 and 2 used the earlier mock
(gpt-4o-mini wrong on 4% of prompts).

**Run 1: windows/amd64, no config store** (`tmp/bifrost-http.exe`)

```
Primary traffic: 300 ok, 0 failed, 77 streamed, 153 marked x-bf-shadow: sampled
done: 153 sampled, 306 compared (8 candidate errors), 0 dropped
openai/gpt-4o-mini   155  96.1%  lower 91.8%  errors 0.0%  judge 9.0/8.7  savings 97.3%  READY
openai/llama-3.1-8b  155  69.0%  lower 61.4%  errors 5.8%  judge 9.0/7.1  savings 99.3%  NOT READY
```

Also checked by hand: `x-bf-shadow: sampled` on a unary and a streaming response,
`/api/shadow/records?candidate=…&outcome=fail` returning judge reasons ("response B is
incorrect or malformed") for wrong capitals, `/api/shadow/canary-rule` for a known pair (200)
and an unknown pair (404).

**Run 2: linux/amd64 in Docker, SQLite config store, `examples/shadow-demo/run.sh`**

```
Primary traffic: 300 ok, 0 failed, 77 streamed, 152 marked x-bf-shadow: sampled
done: 152 sampled, 304 compared (7 candidate errors), 0 dropped
openai/gpt-4o-mini   152  95.4%  lower 90.8%  errors 0.0%  judge 9.0/8.7  savings 97.2%  READY
openai/llama-3.1-8b  152  61.8%  lower 53.9%  errors 4.6%  judge 9.0/6.6  savings 99.3%  NOT READY

POST /api/routing/rules -> HTTP 200 "Routing rule created successfully"
  cel_expression: provider == "openai" && model == "gpt-4o"
  targets: openai/gpt-4o 0.9, openai/gpt-4o-mini 0.1
gpt-4o-mini served 13 of 200 follow-up requests (expected 20; within 3 standard deviations)
```

**Runs 3-8: `run.sh` six times in a row, linux/amd64, SQLite config store, mock at 2%**

Every run exited 0: the readiness gate passed, the rule was created, and the canary split
was within 3 standard deviations of 10%.

| Run | Sampled | gpt-4o-mini agreement / lower bound | llama-3.1-8b agreement / lower bound / errors | Canary: mini served |
|---|---|---|---|---|
| 3 | 145 | 99.3% / 96.2%, ready | 60.7% / 52.6% / 3.4%, not ready | 28 of 200 |
| 4 | 162 | 99.4% / 96.6%, ready | 63.0% / 55.3% / 4.3%, not ready | 22 of 200 |
| 5 | 144 | 100.0% / 97.4%, ready | 66.0% / 57.9% / 2.1%, not ready | 32 of 200 |
| 6 | 150 | 100.0% / 97.5%, ready | 66.0% / 58.1% / 3.3%, not ready | 25 of 200 |
| 7 | 135 | 99.3% / 95.9%, ready | 71.9% / 63.7% / 2.2%, not ready | 20 of 200 |
| 8 | 164 | 100.0% / 97.7%, ready | 66.5% / 58.9% / 3.0%, not ready | 20 of 200 |

## Dashboard in a browser

Gateway built with the dashboard embedded, in Docker with a SQLite config store and demo
traffic loaded. Checked by hand at 1440x900, dark theme:

- The page renders under **Models → Shadow Traffic**: six counter tiles, a scorecard row per
  candidate, `Ready` and `Not ready` badges with their reasons.
- **View disagreements** for llama-3.1-8b lists the failing pairs with paging (1-20 of 41).
  The outcome filter switches to "Candidate errors" and shows 6 records, matching the
  scorecard's "6 of 124 failed". Expanded records show both answers, the judge's scores and
  reason, the judge label line, and an upstream `HTTP 503` for error records.
- **Promote to canary**: weight `0` shows "Must be at least 1"; `25` updates the preview to
  75/25; a not-ready candidate shows the caution panel with its reason; **Create canary rule**
  shows a confirmation and the rule appears on **Routing Rules** (global scope, priority 10,
  enabled). 200 follow-up requests: gpt-4o-mini served 52 (26%; 3 standard deviations around
  25% is 32-68).
- **Reset** asks for confirmation, then zeroes the counters, shows the empty scorecard, and
  moves "Collecting since" to the reset time while today's spend stays.

## Dashboard E2E (Playwright)

`tests/e2e/features/shadow-traffic/` follows the repository's E2E conventions: a
`ShadowTrafficPage` page object on `data-testid` selectors, the shared base fixture, data
factories, and cleanup of every routing rule a test creates (the delete is asserted, so a leak
fails the test). Assertions compare the page with the live API: tile values, verdict labels,
record ids and totals per filter, the judge-order line, and the stored rule's targets.

| Group | Tests |
|---|---|
| Scorecard | counter tiles and a verdict per candidate, with one unique row id per experiment and candidate; pause and resume live updates (one accessible name in both states) |
| Disagreements | switch the weak candidate between disagreements and errors; expand a record to both answers and the judge's verdict |
| Promote to canary | share validation and preview rebuild (rule name, share, priority badge, the `priority` sent); caution for a candidate that is not ready; create a rule and find it on **Routing Rules**; ramp: promoting the same pair again updates its rule in place (a PUT, no POST; same id, priority, scope and condition at the new share); a second pair's canary gets the next free priority (the earlier 409) |
| Reset | counters cleared, empty scorecard |
| Without the plugin | the page explains how to enable it |

When the gateway has too little shadow data, `beforeAll` mirrors three rounds of the demo
prompts and waits until the queue is empty, so the suite also runs from an empty store. The
data tests skip when `/api/shadow/summary` answers 404, and the not-enabled test skips
otherwise, so under `make run-e2e` (whose config has no shadow plugin) only the not-enabled
test runs.

Run against a gateway in Docker (demo config, SQLite config store, setup token), with the
repository's Playwright config minus its `globalSetup` (which builds MCP demo servers this suite
does not use), windows/amd64, Playwright 1.57:

```
Run 1 (data from the demo traffic): 9 passed, 1 skipped (16.1s)
Run 2 (empty store, re-seeded):     9 passed, 1 skipped (24.6s)
Gateway without the plugin, twice:  the not-enabled test passed, data tests skipped
```

After both runs `GET /api/routing/rules` returned no rules.

After the review fixes and the dashboard's canary ramp (gateway rebuilt with the new dashboard,
`allow_force_header: true` because the suite seeds with `x-bf-shadow: force`), with the ramp
and next-free-priority tests added:

```
Run 1: 11 passed, 1 skipped (23.9s)   auth setup + 10 shadow-traffic tests; not-enabled skipped
Run 2: 11 passed, 1 skipped (32.0s)   from the store the reset test cleared, re-seeded
```

After each run `GET /api/routing/rules` returned `[]`. The new tests were not run against the
previous UI to watch them fail; the row-id test asserts exact per-pair ids, which the old
candidate-only ids would not match, and the priority test repeats the request sequence that
returned 409.

## Clean setup from upstream

**Without the dashboard.** `scripts/setup.sh` with `SKIP_UI=1` in a fresh
`golang:1.27-bookworm` container: clones upstream, checks out `ed62e4b`, copies the new files,
applies the patches, writes `go.work`, runs the plugin, handler and schema tests, and builds
the gateway with cgo.

**Timed, at `7293821`.** The same in a fresh `golang:1.27-bookworm` container, from a
`git archive` of the pushed commit, with an empty Go module cache: `SKIP_UI=1 setup.sh` took
524 s (clone, five patches, plugin, handler and schema tests, gateway build), and `run.sh`
against the built binary took 231 s. Its scorecard: gpt-4o-mini 135 samples, 99.3% agreement,
lower bound 95.9%, `ready`; llama-3.1-8b 63.0%, 5.9% errors, `not_ready`. It created the canary
rule (HTTP 200), and gpt-4o-mini then served 27 of 200 requests against 20 expected, which the
script's check accepts as a 10% split.

**With the dashboard.** relayproof at `9962752` cloned into a fresh `node:26-bookworm`
container (Node 26.13.0, npm 11.20.0, gcc 12.2.0) with Go 1.27.4 added; `scripts/setup.sh`
then took 846 s:

```
  0001-register-shadow-plugin.patch
  0002-config-schema.patch
  0003-docs-nav.patch
  0004-dashboard-api.patch
  0005-dashboard-page.patch
ok  github.com/maximhq/bifrost/plugins/shadow
ok  github.com/maximhq/bifrost/transports/v2/bifrost-http/handlers
ok  github.com/maximhq/bifrost/transports/v2/bifrost-http/lib
```

The built gateway embeds the dashboard (the shadow page's bundle is in
`transports/bifrost-http/ui/assets`), the 22 dashboard tests pass in that checkout, and
`run.sh` against the binary created the canary rule (HTTP 200); gpt-4o-mini then served 15 of
200 follow-up requests.
