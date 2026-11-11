# Bifrost Shadow

Shadow traffic evaluation for the [Bifrost](https://github.com/maximhq/bifrost) AI gateway.

> Prove a cheaper model is good enough on your real production traffic before you switch,
> then roll it out to a slice of users with one click.

Built for the Geek Room Global AI Hackathon 2026, Bifrost track, PS04 (contribute a missing
feature to the open-source gateway). Everything here is written as an upstream contribution:
a built-in plugin, a gateway API, a dashboard page, schema, docs and tests, applied to
`maximhq/bifrost@ed62e4b` by one script.

## The problem

Model spend is the largest line item for most AI products, and the cheapest fix is a cheaper
model. Teams rarely switch because they cannot answer one question with confidence: *on our
traffic, is the cheaper model as good?* Offline eval sets do not look like production prompts,
and an A/B test exposes real users before the answer is known.

Bifrost already has the pieces around that question (routing rules, weighted targets, a model
catalog with prices, plugins), but no way to test a model on live traffic without serving its
answers. Neither the open-source gateway nor its enterprise docs offer shadow or mirrored
traffic.

## What it does

```
client ──► Bifrost ──► primary model ──► answer to client (unchanged)
              │
              └─ sampled copy, after the response ──► candidate models
                                                       LLM judge (order randomized)
                                                       embeddings, JSON + tool-call checks
                                                         │
                       scorecard ◄── records ◄───────────┘
                           │
                           └─ "Promote to canary" ──► weighted routing rule (90/10)
```

- **Mirror** a sample of chat completions (streaming included) to any number of candidates per
  source model. Unsampled requests pay about 100 ns and no allocations; the primary answer
  never waits for shadow work.
- **Compare** every pair with an LLM judge (position-randomized), embedding similarity, token
  F1, tool-call and JSON-structure matching, finish reasons, latency and cost.
- **Decide** with statistics, not anecdotes: a candidate is `ready` only when the 95% Wilson
  lower bound of its agreement rate clears the threshold and its error rate is within budget.
- **Inspect** every disagreement side by side with the judge's reason.
- **Promote** a ready candidate to a weighted canary routing rule from the dashboard or API.
- **Stay safe**: bounded queue and workers, daily budget, per-request opt-out header (the
  force header is off unless the operator allows it), virtual-key allow-list, payload storage
  switch. Shadow calls are internal requests: no plugin recursion, no billing to the caller's
  virtual key, and no MCP tools run on them.

## Demo result (no API keys)

`examples/shadow-demo` runs a deterministic mock upstream behind a real Bifrost gateway and
replays 300 mixed requests (QA, arithmetic, JSON mode, tool calls, writing; 25% streamed):

```
CANDIDATE            SAMPLES  AGREE  LOWER95  ERRORS  JUDGE (P/C)  P50 (P/C)     SAVINGS  $/1M REQ  VERDICT
openai/gpt-4o-mini   162      99.4%  96.6%    0.0%    9.0 / 9.0    918 / 339 ms  97.2%    $294      READY
openai/llama-3.1-8b  162      63.0%  55.3%    4.3%    9.0 / 6.6    900 / 195 ms  99.3%    $300      NOT READY
```

Sampling is random, so numbers move between runs; in six consecutive runs `gpt-4o-mini` was
`ready` every time (lower bound 95.9-97.7%) and `llama-3.1-8b` never was.

Both candidates are much cheaper; only one is safe. The script checks that `gpt-4o-mini` is
`ready`, promotes it to a 10% canary through the routing-rules API, and checks the split on
follow-up traffic.

## Dashboard

**Models → Shadow Traffic** in the Bifrost UI:

![Shadow Traffic page: counter tiles and one scorecard row per candidate](docs/media/ui-shadow-traffic.png)

- Counters for sampled, compared, failed and dropped comparisons, and eval spend against the
  daily budget.
- One scorecard row per candidate: verdict, agreement with its 95% lower bound, error rate,
  judge record, p50/p95 latency, savings and projected monthly cost.
- **View disagreements**: failing pairs side by side with the judge's scores and reason, and
  which label (A or B) the candidate had in the judge's randomized order.
- **Promote to canary**: choose a share of traffic, preview the routing rule, create it.
- **Reset**: clear results. Today's eval spend is kept, so the daily budget still applies.

![Disagreements sheet: primary and candidate answers side by side with the judge's verdict](docs/media/ui-shadow-disagreements.png)

Both screenshots are from the key-free demo (`examples/shadow-demo`), so the answers come
from the mock upstream.

## Quick start

```bash
# Clone upstream at the pinned commit, add the plugin, apply patches, build UI + gateway
bifrost-shadow/scripts/setup.sh                 # SKIP_UI=1 to skip the dashboard build

# Run the key-free demo
BIFROST_BIN=../bifrost/tmp/bifrost-http ../bifrost/examples/shadow-demo/run.sh
```

Requirements: git, Go 1.27+, a C compiler (SQLite config store), and for the dashboard the
Node version in Bifrost's `ui/.nvmrc` (26 at the pinned commit).

Minimal `config.json` for real providers:

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

Full reference: [`docs/features/shadow-traffic.mdx`](docs/features/shadow-traffic.mdx).

## Layout

This directory mirrors the Bifrost source tree. New files are copied in; changes to existing
upstream files are patches against `ed62e4b`.

| Path | What |
|---|---|
| `plugins/shadow/` | The plugin (Go module `github.com/maximhq/bifrost/plugins/shadow`): sampling, capture, workers, comparison, judge, store, scorecards, canary rules |
| `transports/bifrost-http/handlers/shadow.go` | `/api/shadow/*` HTTP API |
| `examples/shadow-demo/` | Mock upstream, load generator, gateway config, `run.sh` |
| `docs/features/shadow-traffic.mdx` | Feature documentation |
| `ui/app/workspace/shadow/` | Dashboard page: counters, scorecard, disagreements sheet, promote dialog |
| `ui/lib/` | RTK Query client (`shadowApi.ts`), types, formatting helpers and their vitest cases |
| `tests/e2e/features/shadow-traffic/` | Playwright suite for the dashboard page: page object, data factories, specs |
| `patches/0001-register-shadow-plugin.patch` | Built-in plugin registration, executor and pricing wiring, routes |
| `patches/0002-config-schema.patch` | `config.schema.json` entry and schema tests |
| `patches/0003-docs-nav.patch` | Docs navigation |
| `patches/0004-dashboard-api.patch` | Cache tags and API client export |
| `patches/0005-dashboard-page.patch` | Sidebar entry, canary form schema, strings in all 11 UI languages |
| `scripts/setup.sh` | Clone, overlay, patch, test, build |

## Design notes

- **Hooks.** `PreLLMHook` matches, samples and snapshots; `PostLLMHook` collects the primary
  answer (accumulating stream chunks until `IsFinalChunk`) and enqueues one job per candidate.
  HTTP transport hooks read the `x-bf-shadow` header and mark sampled responses.
- **No stream data in context.** Captures live in a `sync.Map` keyed by request ID, as
  `AGENTS.md` requires, with a janitor that sweeps captures whose response never completed.
- **Internal sub-requests.** Candidate, judge and embedding calls go through the Bifrost client
  with `PrepareContextForInternalRequest`, the same mechanism the semantic cache uses: no plugin
  pipeline, no governance billing, no shadow-of-shadow.
- **Pricing.** Costs come from the model catalog (`CalculateCostForUsage`), with optional manual
  overrides for self-hosted models.
- **Readiness.** Agreement uses a Wilson score interval, so 20/20 passes (lower bound 84%) is
  `promising`, not `ready`.

## Overhead

`go test -bench . -benchmem -count=5` in `plugins/shadow`, medians (windows/amd64, 32 threads):

| Path | ns/op | allocs/op |
|---|---|---|
| Request not matching any experiment | 68 | 0 |
| Matching but not sampled | 99 | 0 |
| Matching but not sampled, every core at once | 54 | 0 |
| Not sampled while another sampled request is in flight | 160 | 0 |
| PostLLMHook with nothing captured | 3 | 0 |
| Response-header hook, not sampled | 2 | 0 |
| The plugin's own work per streamed chunk | 0.4 | 0 |
| Sampled request (snapshot + hand-off) | 9,600 | 33 |

## Limitations

- Chat completions only; the Responses API, embeddings, images and audio are not mirrored.
- Records are per gateway node and in memory (optionally appended to a JSONL file).
- Candidates are compared with the primary, not with ground truth.
- Tool calls are compared, never executed; multi-turn agents are evaluated one turn at a time.
