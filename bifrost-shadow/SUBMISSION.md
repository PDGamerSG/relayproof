# Bifrost Shadow: hackathon submission

**Status: draft.** Nothing has been submitted, published or posted. The public repository does
not exist yet; creating it needs the team's explicit go-ahead. Every number below comes from
[`README.md`](README.md) or [`TESTING.md`](TESTING.md). Open items are marked `TODO`.

## At a glance

| | |
|---|---|
| Project | Bifrost Shadow: shadow traffic evaluation for the Bifrost AI gateway |
| Event | Geek Room Global AI Hackathon 2026 (HackCulture), Bifrost track |
| Track | Problem Statement 04, "Build a Feature the Open-Source Gateway Is Missing" |
| Team | vulcan, two members. TODO: member names and roles as they should appear in the submission |
| Base | `maximhq/bifrost@ed62e4b`, applied by one script (`scripts/setup.sh`) |
| Prototype deadline | 15 November 2026, 11:59 PM as displayed in the event dashboard. Internal cutoff: 15 November, 6 PM IST |
| Judging | 29 November 2026 |
| Required | Public repository, working prototype, detailed README, architecture and pitch materials (deployment optional) |
| Who submits | The team leader. The portal gives only the leader create and manage access for submissions |

## Track choice: why PS04

PS04 asks for a real operational gap, closed through the gateway's supported interfaces, with
standard installation, tests and docs, at upstream quality. Bifrost Shadow is scoped to that:

- **The gap is real and specific.** Bifrost can route traffic between models (routing rules,
  weighted targets) and knows what each model costs (the model catalog), but it cannot tell an
  operator whether a cheaper model is good enough on their own traffic. At the pinned commit it
  has no shadow or mirrored traffic, and the README notes that the enterprise docs do not offer
  it either.
- **Supported interfaces only.** It is a built-in plugin using the existing hook interfaces, an
  HTTP handler registered like the other `/api` handlers, a dashboard page in the existing UI,
  and an entry in `config.schema.json`. Promotion uses the existing routing-rules API.
- **Standard installation.** The plugin is enabled from `config.json` or `/api/plugins` like any
  built-in plugin. `scripts/setup.sh` clones upstream at `ed62e4b`, copies the new files,
  applies five patches, runs the tests and builds the gateway.
- **Tests, docs and the upstream rules.** Unit, handler, schema and dashboard tests, a race
  detector run, benchmarks with a cost statement as Bifrost's `AGENTS.md` requires, a Mintlify
  docs page, and strings in all 11 UI languages. [`UPSTREAM_PR.md`](UPSTREAM_PR.md) is the draft
  pull request.

## One-line pitch

Test a cheaper model on your real production traffic without users ever seeing its answers,
then promote it to a weighted canary when the statistics say it is ready.

## Project description

Bifrost Shadow adds shadow traffic evaluation to the open-source Bifrost AI gateway. Teams want
to move to cheaper models but cannot tell whether a candidate is good enough on their own
traffic: offline eval sets do not match production prompts, and an A/B test exposes users before
the answer is known. The shadow plugin copies a sample of live chat completions, streaming
included, and replays each one against candidate models after the primary answer has been sent,
so users only ever see the primary. Each pair is scored by a position-randomized LLM judge,
embedding similarity, token overlap, and tool-call and JSON-structure checks. Per candidate, a
dashboard page shows agreement with its 95% Wilson lower bound, error rate, latency, savings and
a readiness verdict, and lets an operator promote a ready candidate to a weighted canary routing
rule. In benchmarks, an unsampled request costs about 100 ns and no allocations. It is built as
an upstream contribution with schema, docs and tests.

## Problem, solution, why now

**Problem.** Switching to a cheaper model is the most direct way to cut model spend, and teams
rarely do it because they cannot answer one question with confidence: on our traffic, is the
cheaper model as good? Offline eval sets do not look like production prompts. An A/B test
answers the question by exposing real users to the candidate before anyone knows it is safe.

**Solution.** Mirror a sample of live requests to the candidate in the background, after the
primary has answered, and compare the two answers. The client always gets the primary's answer,
unchanged. Per candidate, the gateway reports how often the candidate was an acceptable
substitute, with a 95% Wilson lower bound so that a short lucky streak is not mistaken for
evidence, plus error rate, latency and cost. A `ready` candidate is promoted to a 90/10 (or any
other) weighted routing rule, so the real rollout starts small and is reversible.

**Why now.** Bifrost's recent work is about deciding where traffic goes: routing rules with
weighted targets, a complexity router in the docs, and open pull requests for named model
routers and model-routing rules (as seen on 10 November 2026). Each of these moves traffic
between models; none measures whether the destination model holds up on the operator's
traffic. The pieces shadow evaluation needs are already in the gateway (internal sub-requests,
catalog prices, weighted routing rules), so the feature is a plugin and a page rather than a new
subsystem.

## What is new and what Bifrost already has

| Capability | Bifrost at `ed62e4b` | Bifrost Shadow |
|---|---|---|
| Routing rules with weighted targets | Exists | Used as the canary. The plugin builds the rule body; the existing API creates it |
| Model catalog with prices | Exists | Prices candidate, judge and embedding calls (`CalculateCostForUsage`), with optional manual overrides |
| Plugin hooks (LLM and HTTP transport) | Exist | The shadow plugin is a built-in plugin on these hooks |
| Semantic cache | Exists | Runs before the shadow plugin; cache hits are not sampled or compared |
| Internal sub-requests (`PrepareContextForInternalRequest`) | Exist, used by the semantic cache and the routing classifier | Used for every candidate, judge and embedding call |
| Shadow or mirrored traffic | Not present | New: sampling, request snapshot, stream capture, non-blocking hand-off, bounded workers, daily budget |
| Pairwise comparison against the served answer | Not present in the gateway | New: LLM judge with randomized order, embeddings, token F1, tool-call and JSON-shape matching |
| Readiness verdict | Not present | New: 95% Wilson lower bound against `min_agreement`, error-rate gate |
| Promotion to canary | Not present | New: one dialog from scorecard to routing rule |

Mirroring traffic is not a new idea, and Maxim, the company behind Bifrost, offers a separate
evaluation product that covers offline and production evaluation broadly. Bifrost Shadow is
narrower: it lives inside the open-source gateway, evaluates the gateway's own traffic, and ends
in a gateway routing rule.

## Run it (target: under 5 minutes once built)

The scripts need bash, git, Go 1.27+, a C compiler (the SQLite config store uses cgo), and, for
the dashboard, the Node version in Bifrost's `ui/.nvmrc` (26 at the pinned commit). No API keys
are needed for the demo.

```bash
# 1. Build (one time): clone upstream at ed62e4b, add the plugin, apply the patches, test, build
bifrost-shadow/scripts/setup.sh                 # SKIP_UI=1 skips the dashboard build

# 2. Run the key-free demo: mock upstream, gateway, 300 requests, scorecard, canary, split check
BIFROST_BIN=../bifrost/tmp/bifrost-http ../bifrost/examples/shadow-demo/run.sh
```

The five-minute path assumes step 1 is already done. In `TESTING.md`, a clean `setup.sh` run
with the dashboard took 846 s in a fresh container.

- TODO: time `setup.sh` with `SKIP_UI=1` and one `run.sh`, and record both in `TESTING.md`.
- TODO: decide whether to attach prebuilt gateway binaries to a release of the public
  repository. None are published today.

To look at the dashboard, keep a gateway running by hand (`run.sh` stops its gateway when it
exits). Follow "Run the pieces by hand" in
[`examples/shadow-demo/README.md`](examples/shadow-demo/README.md), then open the gateway in a
browser and go to **Models → Shadow Traffic**.

## Three-minute live demo script

**Before recording (not timed)**

1. Build with `setup.sh`, or reuse a binary built earlier with it.
2. Terminal A: run `run.sh` on spare ports so it does not collide with the dashboard gateway,
   and keep its output on screen:
   `BIFROST_BIN=… PORT=8081 MOCK_ADDR=127.0.0.1:18081 ./run.sh`.
   TODO: measure how long it takes; if it does not fit, start it before recording and show the
   finished output.
3. Terminal B: start the mock and a gateway on port 8080 by hand with the demo config, then
   `bin/loadgen -n 300 -c 12` so the scorecard has data. Start from a fresh copy of the demo app
   directory, so no routing rule or stored record from a rehearsal is left over.
4. Browser: open the gateway, get past the setup-token screen if one appears (TODO: confirm what
   the dashboard shows on first visit with a setup token), and open **Models → Shadow Traffic**.
5. Keep secrets out of frame. The demo uses a throwaway setup token and no real keys.

**Script**

| Time | Screen | What to show and say |
|---|---|---|
| 0:00-0:20 | Title or the scorecard page | The problem in one sentence: the cheaper model might be good enough, and today the only way to find out is to expose users. Shadow traffic answers it on real traffic with no user impact. |
| 0:20-0:50 | Terminal A, `run.sh` output | A real Bifrost gateway in front of a deterministic mock, no keys. 300 requests, about half marked `x-bf-shadow: sampled`. The scorecard: gpt-4o-mini `READY`, llama-3.1-8b `NOT READY`. The script promotes only a ready candidate, creates the routing rule (HTTP 200), and checks the 10% split on follow-up traffic. |
| 0:50-1:25 | Dashboard, scorecard | Counter tiles: sampled, compared, candidate errors, dropped, eval spend against the daily budget, judge model. One row per candidate: verdict and its reason, agreement with the 95% lower bound, error rate, judge scores, p50/p95 latency, savings. Both candidates are much cheaper; only one is safe. |
| 1:25-2:00 | **View disagreements** on llama-3.1-8b | Failing pairs side by side with the judge's scores and reason, and the line saying which label (A or B) the candidate had. Switch the filter to "Candidate errors" to show the upstream `HTTP 503` records. |
| 2:00-2:35 | **Promote to canary** on gpt-4o-mini, then **Routing Rules** | The default share is 10%. The preview shows the CEL expression and the 0.9 / 0.1 targets. **Create canary rule**, follow the toast to **Routing Rules**, and show the new rule: global scope, priority 10, enabled. |
| 2:35-3:00 | Overhead table (README or slide) | About 100 ns and no allocations for an unsampled request, 7.9 µs and 31 allocations for a sampled one; bounded queue, daily budget, opt-out header. Tested and written as an upstream pull request. One line on limits: chat completions only, per-node records. |

## Judging criteria talking points

The published criteria are innovation, technical execution, problem and potential impact, use
of AI, user experience, and scalability or potential. No weights were published.

- **Innovation.** Takes traffic mirroring into model selection inside the gateway, and closes
  the loop from evidence to rollout: scorecard, statistical gate, one-click weighted canary. The
  verdict uses a confidence bound, not a raw percentage: 20 of 20 passes is `promising`, not
  `ready`.
- **Technical execution.** 64 plugin tests (repeated runs on Windows, also under CPU load, and
  the race detector on Linux), 9 handler tests, 2 schema tests, 31 dashboard helper tests, a
  Playwright suite for the page, the dashboard typecheck and scoped i18n check, and dashboard
  builds on Windows and Linux. Bugs found by testing, by a code review pass and by the E2E
  suite are each recorded with their fix and regression test in `TESTING.md`. Eight recorded end-to-end
  runs through a real gateway, a dashboard check in a browser, and a clean build from upstream
  that passed `run.sh`.
- **Problem and impact.** In the demo, with the mock's prices from the demo config, the ready
  candidate saves 97.2% per request (README). These are demo prices against a mock, not a
  measurement on a customer's traffic. The point is the decision: the cheaper model that is not
  safe (llama-3.1-8b, 63.0% agreement in the same run) is blocked.
- **Use of AI.** An LLM judge scores each pair with the order of the answers randomized and its
  JSON reply parsed and mapped back; embeddings add a semantic signal; the AI's judgement is
  aggregated with statistics before anyone acts on it, and every judge reason is inspectable.
- **User experience.** A page in Bifrost's own dashboard, in all 11 UI languages, with a
  not-enabled state, verdict reasons, a disagreement viewer that says which answer was the
  candidate, a promote dialog with a live rule preview and a warning for candidates that are not
  ready, and a reset that keeps the daily budget in force.
- **Scalability and potential.** Bounded queue and workers, a daily budget, an opt-out header,
  a force header that is off unless the operator allows it, a virtual-key allow-list and a
  payload switch keep the cost under the operator's control. Shadow calls never run MCP tools. The
  request-path cost is measured, not asserted. The work is shaped as an upstream PR, with
  follow-ups listed in `UPSTREAM_PR.md`.

## Limitations

- Chat completions only (`/v1/chat/completions` and the integrations that map to it, streaming
  included). The Responses API, embeddings, images and audio are not mirrored.
- Records live in memory on each gateway node, optionally appended to a JSONL file. In a
  cluster, each node reports on the traffic it served. The JSONL file is compacted in place
  once it holds twice `max_records` lines.
- Candidates are compared with the primary, not with ground truth. A judge measures "as good as
  the primary".
- Tool calls are compared, never executed. Multi-turn agents are evaluated one turn at a time.
- The daily budget is only as accurate as the prices: a model with no catalog price and no
  manual override is counted as free. The budget is checked before work starts, so jobs already
  running can go slightly over it.
- The API and dashboard allow promoting a candidate that is not `ready` (the dialog warns);
  only the demo script enforces `ready`.
- All recorded end-to-end runs use the deterministic mock upstream. No run against real provider
  APIs is recorded in `TESTING.md`. TODO: record one small real-provider run before submission.
- The request-path figures are microbenchmarks (one parallel benchmark covers contention on
  the unsampled path). Gateway latency under load with the plugin enabled has not been
  measured.

## Submission checklist

- [ ] Public repository. **Not created.** Publication needs the team's explicit go-ahead.
  Publish `bifrost-shadow/` as a clean repository; keep the private research archive and the
  event dashboard material out of it. TODO: choose a license (upstream Bifrost is Apache-2.0).
- [x] Detailed README: [`README.md`](README.md).
- [x] Verification log: [`TESTING.md`](TESTING.md).
- [x] Architecture: [`media/architecture.svg`](media/architecture.svg) and
  [`ARCHITECTURE.md`](ARCHITECTURE.md).
- [x] Feature docs: [`docs/features/shadow-traffic.mdx`](docs/features/shadow-traffic.mdx).
- [x] Working prototype: `run.sh` passed six consecutive runs and a run from a clean upstream
  build (`TESTING.md`).
- [ ] Demo video. To record, following the script above. TODO: link.
- [ ] Pitch deck. Outline below. TODO: build and link.
- [x] Dashboard E2E tests (Playwright): `tests/e2e/features/shadow-traffic/`, results in
  `TESTING.md`.
- [ ] Upstream pull request. Draft in [`UPSTREAM_PR.md`](UPSTREAM_PR.md); not posted.
- [ ] Leader checks the portal countdown and timezone, and inspects any existing submission
  record before replacing it.
- [ ] Leader submits the form, then confirms the receipt. Disclose AI assistance where the form
  asks for it.

## Pitch deck outline

1. **Title.** Bifrost Shadow: test a cheaper model on real traffic, then canary it. Team vulcan,
   PS04.
2. **Problem.** The cheaper model might be good enough, but offline evals miss production
   prompts and A/B tests expose users first.
3. **The gap.** Bifrost has routing rules, weighted targets, catalog prices, plugins and a
   semantic cache; it has no shadow or mirrored traffic.
4. **How it works.** The architecture diagram: live path above the line, background evaluation
   below, nothing below delays the client.
5. **Deciding with statistics.** Pass rule per pair, then the 95% Wilson lower bound per
   candidate: 20 of 20 passes is `promising`, not `ready`.
6. **Demo result.** gpt-4o-mini `READY` (99.4% agreement, lower bound 96.6%), llama-3.1-8b
   `NOT READY` (63.0%, 4.3% errors), both on mock prices; six runs, same verdicts.
7. **Promote to canary.** Scorecard to a 90/10 routing rule in one dialog; the rule appears on
   the Routing Rules page and the split shows up in follow-up traffic.
8. **Cost on the request path.** About 100 ns and no allocations unsampled, 7.9 µs and 31
   allocations sampled; bounded queue, daily budget, opt-out header.
9. **Built like an upstream PR.** Plugin, API, page, schema, docs, 11 languages, tests and
   bugs found by testing, review and E2E each fixed with a regression test, on top of
   `ed62e4b` with one script.
10. **Limits and next steps.** Chat completions only, per-node records, mock-only runs so far;
    links to the repository and the video (TODO).
