# Agent Gauntlet

A benchmarking platform for AI **agents**, not just models.

Model benchmarks (MMLU, HumanEval, ...) score a single prompt in isolation. Real agents
fail differently: they compound small errors across steps, misuse tools, burn tokens on
loops, and break when a tool is flaky, a provider dies mid-run, or a tool returns
plausible-but-wrong output. Agent Gauntlet measures *that*.

Built for the Geek Room Global AI Hackathon (Bifrost track), on top of the open-source
[Bifrost](https://github.com/maximhq/bifrost) gateway: every model call in a run goes
through one local gateway, which gives the platform uniform per-call metering
(tokens, latency) across any provider Bifrost supports.

## What it measures

Per agent x task x repetition:

- **Success rate** - deterministic graders, no LLM judging
- **Steps and tool calls** to completion (and where runs loop or stall)
- **Token usage and latency** per run and per successful outcome, via Bifrost metering. Estimated cost is available for the reference model from dated published list prices (bench/pricing.json); unknown models show "unavailable". Actual billed and cross-provider cost are not measured; reference runs paid $0.
- **Wall-clock latency**
- **Resilience** under synthetic failure injection: flaky tools, mid-run provider
  outage, and misleading tool output. Injection runs only inside the platform's own
  synthetic tool environments - never against real people, accounts, or services.

## Layout

- `bench/gateway.py` - OpenAI-compatible client for the local Bifrost gateway
- `bench/envs/` - synthetic tool environments (docs store, ticket tracker) + failure injectors
- `bench/agents.py` - the test agents under benchmark (ReAct variants)
- `bench/tasks.py` - task suite with deterministic graders
- `bench/runner.py` - run matrix executor with hard budget caps, JSONL traces
- `bench/report.py` - static HTML report + per-run trace viewer
- `docs/` - architecture and infra notes

## Quickstart

1. Run a local Bifrost gateway with at least one provider configured (see `docs/infra.md`).
2. `export BIFROST_URL=http://127.0.0.1:18777 BIFROST_VK=<virtual-key>`
3. `python -m bench.runner --suite core --reps 3 --out traces/run.jsonl`
4. `python -m bench.report traces/run.jsonl --out report.html`

The runner refuses to exceed a daily usage budget (`BENCH_DAILY_NEURON_CAP`, default
conservative) and a per-run step cap, so benchmarking a free-tier upstream stays free.

## For judges: evaluate in 5 minutes

No API keys are needed to inspect the evidence: `docs/infra.md` has the full setup,
provider constraints found, and validation notes. Grader behavior needs no provider:

- `python -m bench.controls` - 36 shipped positive/negative control cases: every
  grader must accept correct answers and reject wrong, look-alike, and contradictory
  ones (exit 1 on any misbehavior).

To re-run the benchmark yourself:

1. Start any Bifrost gateway with one chat provider (a free-tier key is enough; the
   reference runs used Cloudflare Workers AI free tier).
2. `python -m bench.runner --suite core --reps 2 --out /tmp/run.jsonl` - 28 runs,
   about a minute on the reference setup.
3. `python -m bench.report /tmp/run.jsonl --out report.html` and open it: per-task
   pass rates, token/step/latency distributions, and a trace viewer showing every
   model turn and tool call, including injected faults.

## Reference results (validated)

112-run matrix: 4 base tasks + 3 fault-injection variants, x 2 agents x 8 reps,
Cloudflare Workers AI free tier via local Bifrost, 2026-11-08, grader v2.
Agents: `react-concise` (minimal prompt) and `react-skeptic` (instructed to verify
tool output and retry failed calls).

| Case | concise | skeptic | What it shows |
| --- | --- | --- | --- |
| docs.single_hop.refund_window | 8/8 | 8/8 | baseline retrieval |
| tickets.priority.open_critical | 8/8 | 8/8 | second env, list+read chain |
| docs.multi_hop.cron_tz | 8/8 | 8/8 | two-document join |
| docs.three_hop.lag_threshold | 7/8 | 8/8 | concise once answered from excerpts without reading |
| docs.multi_hop.cron_tz .flaky | 4/8 | 6/8 | transient tool errors; retries recover some runs |
| docs.multi_hop.cron_tz .misleading | 0/8 | 0/8 | stress demo: a stale-but-plausible document fools both |
| docs.three_hop.lag_threshold .outage | 0/8 | 0/8 | stress demo: simulated gateway termination mid-run |

Scope and honesty notes:

- The `.flaky`, `.misleading` and `.outage` rows are fault-injection variants of the
  two base tasks above them, not independent tasks.
- Misleading and outage are stress demonstrations: the misleading wrapper overwrites
  the correct document, and the outage injector terminates the gateway connection at
  the first error by design. They show how runs fail, not comparative robustness, and
  they do not exercise Bifrost's real provider-failover features.
- Flaky is the one solvable comparative case: skeptic 6/8 vs concise 4/8 over 8 reps.
  Both agents retry; the gap is consistent with stricter retry behavior helping, but
  n=8 is directional evidence, not proof, and both prompts come from one model
  (Workers AI Llama) on one day.
- Estimated cost: the report includes an "Est. cost (USD)" column computed from
  Cloudflare's published list prices (bench/pricing.json, accessed 2026-11-08) x
  recorded token usage. Reproducible estimate, not an actual bill - reference
  runs paid $0 on the free tier. Unknown models/missing usage show "unavailable".
- Token usage: skeptic used about 46% more tokens than concise (135,168 vs 92,535
  across the full 112-run matrix). Clean runs alone are not identical outcomes
  (three-hop 7/8 vs 8/8), so no clean-only cost-per-success claim is made.
- Graders are keyword/pattern matchers with contradiction checks (grader v2,
  2026-11-08). v2 rejects answers that name a wrong alternative alongside the right
  fact; re-scoring the archived 56-run v1 matrix with v2 flips 0 of 56 outcomes.
  Grading is not semantic - the shipped limits are the control cases in
  `bench/controls.py`.
- The misleading finding is about trust, not flags: the wrapper supplies no
  "stale" metadata; the wrong document is simply plausible.

## Disclosure

This project was built with AI assistance (code generation), disclosed per hackathon rules.
