# Bifrost Shadow: hackathon submission

**Status: draft.** Nothing has been submitted, published or posted. The public repository does
not exist yet; creating it needs the team's explicit go-ahead. Every number below comes from
[`README.md`](README.md) or [`TESTING.md`](TESTING.md). Open items are marked `TODO`.

## At a glance

| | |
|---|---|
| Project | Bifrost Shadow: shadow traffic evaluation for the Bifrost AI gateway |
| Event | Geek Room Global AI Hackathon 2026 (HackCulture), Bifrost track |
| Category | AI Agents & Intelligent Systems (every problem statement of the event sits in this category) |
| Theme to select | **Open-Source Bifrost Gateway** (Problem Statement 04, "Build a Feature the Open-Source Gateway Is Missing"). No Tavily integration, so leave the optional Tavily checkbox unticked |
| Team | vulcan, two members. TODO: member names and roles as they should appear in the submission |
| Base | `maximhq/bifrost@ed62e4b`, applied by one script (`scripts/setup.sh`) |
| Live demo | <https://relayproof.pallabdas.me/live> (console: trial on the hosted gateway, or sign in to your own) and <https://relayproof.pallabdas.me> (overview). Backend on Render, site on Vercel |
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
| Routing rules with weighted targets | Exists | Used as the canary. `POST /api/shadow/promote` writes the rule through the same store and engine reload as the routing-rules API |
| Model catalog with prices | Exists | Prices candidate, judge and embedding calls (`CalculateCostForUsage`), with optional manual overrides |
| Plugin hooks (LLM and HTTP transport) | Exist | The shadow plugin is a built-in plugin on these hooks |
| Semantic cache | Exists | Runs before the shadow plugin; cache hits are not sampled or compared |
| Internal sub-requests (`PrepareContextForInternalRequest`) | Exist, used by the semantic cache and the routing classifier | Used for every candidate, judge and embedding call |
| Shadow or mirrored traffic | Not present | New: sampling, request snapshot, stream capture, non-blocking hand-off, bounded workers, daily budget |
| Pairwise comparison against the served answer | Not present in the gateway | New: LLM judge with randomized order, exact matching, embeddings, tool-selection and JSON-structure gates, agent tool-call metrics |
| Readiness verdict | Not present | New: 95% Wilson lower bound against `min_agreement`, error-rate and judge-health gates; failed evaluations never count as passes |
| Promotion to canary | Not present | New: verdict-gated promotion with an audited override, one rule per source, CEL conflict check against existing rules, dry run |
| Canary monitoring and rollback | Not present | New: live error rate and latency per target, automatic rollback with the triggering evidence in a rollout log |

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

# 2. Run the key-free demo: scorecard, refused and accepted promotion, split check,
#    simulated incident, automatic rollback (run from the repository root)
BIFROST_BIN="$(pwd)/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/run.sh
```

`run.sh` took 1 min 41 s on macOS arm64 once built (`TESTING.md`, round 2). `dev.sh` in the same
directory keeps a seeded gateway running for the separate frontend (`api/README.md`).

The five-minute path assumes step 1 is already done. In `TESTING.md`, a clean `setup.sh` run
with the dashboard took 846 s in a fresh container.

- Timed in a fresh container with an empty Go module cache: `setup.sh` with `SKIP_UI=1` took
  524 s and `run.sh` 231 s (`TESTING.md`, "Clean setup from upstream").
- TODO: decide whether to attach prebuilt gateway binaries to a release of the public
  repository. None are published today.

To look at the dashboard, keep a gateway running by hand (`run.sh` stops its gateway when it
exits). Follow "Run the pieces by hand" in
[`examples/shadow-demo/README.md`](examples/shadow-demo/README.md), then open the gateway in a
browser and go to **Models → Shadow Traffic**.

## Three-minute live demo script

**Simplest: the hosted console, on real Claude models.** Open
<https://relayproof.pallabdas.me/live> (Trial). `claude-opus-5-5` serves; `claude-sonnet-5-5` and
`claude-haiku-5-5` are shadowed and judged by `claude-opus-5-5`.

1. **Ask the gateway**: type a question. Opus answers at once; Sonnet's and Haiku's shadow answers
   appear beside it with latency and the judge's verdict ("Agrees" / "Disagrees").
2. **Scorecards**: on the demo traffic both cheaper models reach Ready (first run: 100% agreement,
   lower bound 92.1% after 45 pairs); Haiku at 98% lower cost, Sonnet at 52%.
3. **Promote** Haiku: the dialog preselects 25% and shows the gateway's dry-run plan (75/25).
4. **Fail 60% of calls** on Haiku, then **Send a burst**: the guard rolls it back on its own within
   about half a minute; Rollout history shows the `auto_rollback` event and its reason.

The outage clears itself after 3 minutes and the scorecards are replayed, so the demo can be run
again. The steps below record the same story from a local build, on the mock upstream.

**Before recording a local run (not timed)**

1. Build with `setup.sh`, or reuse a binary built earlier with it.
2. Terminal A: run `run.sh` on spare ports so it does not collide with the dashboard gateway,
   and keep its output on screen:
   `BIFROST_BIN=… PORT=8081 MOCK_ADDR=127.0.0.1:18081 ./run.sh`.
   It took 231 s in the clean-container run (`TESTING.md`), longer than the demo slot, so
   start it before recording and show the finished output.
3. Terminal B: start the mock and a gateway on port 8080 by hand with the demo config, then
   `bin/loadgen -n 300 -c 12` so the scorecard has data. Start from a fresh copy of the demo app
   directory, so no routing rule or stored record from a rehearsal is left over.
4. Browser: open the gateway, get past the setup-token screen (with a setup token configured, the
   first visit redirects to `/login` and asks for it), and open **Models → Shadow Traffic**.
5. Keep secrets out of frame. The demo uses a throwaway setup token and no real keys.

**Script**

| Time | Screen | What to show and say |
|---|---|---|
| 0:00-0:20 | Title or the scorecard | The problem in one sentence: the cheaper model might be good enough, and today the only way to find out is to expose users. Shadow traffic answers it on real traffic with no user impact, and the gateway keeps watching after rollout. |
| 0:20-0:55 | Terminal, `run.sh` scorecard | A real Bifrost gateway in front of a deterministic mock, no keys. 300 requests, about half sampled. gpt-4o-mini `READY` (lower bound 97.4%), llama-3.1-8b `NOT READY`. Both are about 97-99% cheaper; only one is safe. |
| 0:55-1:30 | Frontend scorecard and disagreements | Agreement with its lower bound, judge scores, agent metrics (tool selection), the failing llama pairs side by side with the judge's reason. |
| 1:30-2:05 | Promotion | Promoting llama is refused with its verdict (409). A dry run of gpt-4o-mini shows one rule, 90/10, no conflicting rules. Promote: 20 of 200 follow-up requests go to gpt-4o-mini, canary health `healthy`. |
| 2:05-2:40 | Incident | Flip the mock's incident switch: gpt-4o-mini fails 60% of requests. Within seconds the canary guard rolls it back (live error rate 19.2%, lower bound 8.5% > 5%); 0 of the next 100 requests reach it. Show the rollout log with the `auto_rollback` event and its evidence. |
| 2:40-3:00 | Overhead and tests | About 100 ns and no allocations for an unsampled request, 14-25 ns per response while a canary is live; 89 plugin tests and 20 gateway tests with the race detector; written as an upstream pull request. Limits: chat completions, per-node state. |

## Judging criteria talking points

The published criteria are innovation, technical execution, problem and potential impact, use
of AI, user experience, and scalability or potential. No weights were published.

- **Innovation.** Takes traffic mirroring into model selection inside the gateway, and closes
  the loop from evidence to rollout and back: scorecard, statistical gate, verdict-gated
  canary, live health, automatic rollback. Every decision uses a confidence bound, not a raw
  percentage: 20 of 20 passes is `promising`, not `ready`, and one failed request in 17 does
  not roll a canary back.
- **Technical execution.** 89 plugin tests (88.7% coverage) and 20 gateway handler tests, all
  under the race detector, 2 schema tests, an OpenAPI contract checked field by field against a
  running gateway, a typed client run end to end, CI on every push. Earlier rounds: repeated
  runs on Windows, also under CPU load, 31 dashboard helper tests, a
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
  The feature is built for agent workloads: tool selection is a required gate (an agent executes
  whatever tool the model picks), tool-call differences are reported by kind, and the canary
  guard is an autonomous controller that acts on live evidence and logs why.
- **User experience.** A typed API and client for the separate frontend (refusals come back with
  the verdict and conflicting rules, so a UI can explain them), and a page in Bifrost's own
  dashboard, in all 11 UI languages, with a
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
  manual override is counted as free. Jobs reserve a moving-average cost, so the cap holds
  within the error of that estimate.
- `POST /api/shadow/promote` enforces `ready` (or a recorded override). The bundled dashboard
  page predates it and still creates rules through the routing-rules API, warning for
  candidates that are not ready.
- Canary health and the rollout log are per gateway node.
- All recorded end-to-end runs use the deterministic mock upstream. No run against real provider
  APIs is recorded in `TESTING.md`. TODO: record one small real-provider run before submission.
- The request-path figures are microbenchmarks (one parallel benchmark covers contention on
  the unsampled path). Gateway latency under load with the plugin enabled has not been
  measured.

## Submission checklist

- [x] Public repository: <https://github.com/PDGamerSG/relayproof> (public since 13 November).
  TODO: choose a license (upstream Bifrost is Apache-2.0).
- [x] Deployment: console and overview on Vercel, demo backend on Render (`render.yaml`,
  `deploy/`).
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
- [ ] Leader submits the form, then confirms the receipt. The event rules ask that the use of AI
  tools be clearly mentioned in the submission: state that AI coding assistants were used in
  development, alongside the LLM judge and embeddings the feature itself uses.

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
6. **Demo result.** gpt-4o-mini `READY` (100% agreement, lower bound 97.4%), llama-3.1-8b
   `NOT READY` (67.1%, 2.7% errors), both on mock prices; same verdicts on every run.
7. **Promote to canary.** The weak candidate is refused with its verdict; the ready one gets a
   90/10 rule after a dry run and a conflict check; the split shows up in follow-up traffic.
8. **The gateway pulls it back.** A simulated provider incident: the canary guard rolls the
   candidate back on confident evidence, 5 failed requests in, and logs the reason.
9. **Cost on the request path.** About 100 ns and no allocations unsampled, about 10 µs and 33
   allocations sampled; bounded queue, daily budget, opt-out header.
10. **Built like an upstream PR.** Plugin, API, page, schema, docs, 11 languages, tests and
   bugs found by testing, review and E2E each fixed with a regression test, on top of
   `ed62e4b` with one script.
11. **Limits and next steps.** Chat completions only, per-node records, mock-only runs so far;
    links to the repository and the video (TODO).
