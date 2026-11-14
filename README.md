# Bifrost Shadow

**Shadow traffic evaluation, gated canary promotion and automatic rollback for the
[Bifrost](https://github.com/maximhq/bifrost) AI gateway.** Test a cheaper model on real
production traffic without users seeing its answers, promote it to a canary only when the
statistics say it is ready, and let the gateway pull it back on its own if it misbehaves live.

| | |
|---|---|
| Event | Geek Room Global AI Hackathon 2026 on HackCulture |
| Category | AI Agents & Intelligent Systems |
| Theme (primary problem statement) | **Open-Source Bifrost Gateway** (PS04) |
| Tavily integration | None |
| Live | [relayproof.pallabdas.me](https://relayproof.pallabdas.me) (overview) and [relayproof.pallabdas.me/live](https://relayproof.pallabdas.me/live) (live console on real Claude models: `claude-opus-5-5` serves, `claude-sonnet-5-5` and `claude-haiku-5-5` are shadowed and judged; ask your own question, read every comparison with word-level diffs, see agreement by kind of request, check how far to trust the judge, try other thresholds in the policy lab, see latency and cost per model, promote and let the guard ramp it up, break, watch the rollback, print a readiness report, build your own config; or sign in to your own gateway) |
| Hosted backend | [`bifrost-shadow/deploy/`](bifrost-shadow/deploy/): gateway, mock upstream and a public front door in one container, on Render ([`render.yaml`](render.yaml)) |
| Application | [`bifrost-shadow/`](bifrost-shadow/README.md) |
| Frontend contract | [`bifrost-shadow/api/`](bifrost-shadow/api/README.md): OpenAPI spec, typed TypeScript client, connection guide |
| Verification | [`bifrost-shadow/TESTING.md`](bifrost-shadow/TESTING.md) |

## Quick start

From this directory (needs git, Go 1.27+ and a C compiler; no API keys):

```bash
# Clone upstream Bifrost at the pinned commit into ./bifrost, add the plugin, apply patches, test, build
SKIP_UI=1 bifrost-shadow/scripts/setup.sh

# Key-free demo: scorecards, refused and accepted promotion, simulated incident, automatic rollback
BIFROST_BIN="$(pwd)/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/run.sh

# A seeded gateway that keeps running, for frontend work
BIFROST_BIN="$(pwd)/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/dev.sh
```

`./bifrost/` is a generated build tree and is ignored by Git.

## Repository layout

| Path | What |
|---|---|
| `bifrost-shadow/` | The implemented project: plugin, gateway API, patches against upstream, docs, demo, tests |
| `.github/workflows/shadow.yml` | CI: clean build on pinned upstream, race tests, the full demo, client typecheck |
| `research/`, `docs/`, `CLAUDE_HANDOFF.md` | Archive of the earlier RelayProof research and plan (not implemented) |

---

# Research archive: RelayProof

> The team built [Bifrost Shadow](bifrost-shadow/README.md) instead of the RelayProof plan
> below. The research and plan are kept for reference and describe work that was not built.

**Recommendation: build a Bifrost upgrade and compatibility lab that turns a broken agent workflow into a small, replayable regression test.** Pair it with a narrowly focused stale-answer verifier for AI-generated API migration advice.

Research date: **10 November 2026**. This directory contains a specification and implementation plan, **not an implemented application**. Proposed features, budgets, scores, and milestones below are design decisions, not measured product results.

Private repository: **[PDGamerSG/relayproof](https://github.com/PDGamerSG/relayproof)**. It retains the research and sanitized source archive for the implementation handoff. Keep this repository private. Build the application in the `relayproof/` subdirectory without a nested Git repository; prepare a separate clean public application repository when publication is authorized.


## Start here in the morning

Give Claude **[CLAUDE_HANDOFF.md](CLAUDE_HANDOFF.md)** with this whole directory available. It provides the exact reading order, decisions, build sequence, and acceptance conditions. No further idea selection is needed.

| Document | Purpose |
|---|---|
| [Recommendation and research](research/RECOMMENDATION.md) | Event facts, company and staff work, competitors, rejected alternatives, reasoning |
| [Product specification](docs/superpowers/specs/2026-11-10-relayproof-design.md) | Users, complete workflow, features, priorities, UX, release requirements |
| [Technical design](docs/TECHNICAL_DESIGN.md) | Architecture, protocols, data structures, algorithms, persistence, APIs, security |
| [Implementation plan](docs/superpowers/plans/2026-11-10-relayproof.md) | Ordered tasks, file paths, contracts, test examples, commands, delivery gates |
| [Evaluation and demo](docs/EVALUATION_AND_DEMO.md) | Scenario matrix, mutation tests, metrics, independent checks, demo script |
| [Submission draft](docs/SUBMISSION_DRAFT.md) | Track choice, honest project copy, pitch outline, submission checklist |
| [Public project catalog](research/PROJECT_CATALOG.md) | All 46 matches from the documented GitHub query, plus inspected comparators |
| [Evidence map](research/EVIDENCE_MAP.md) | Material claims, primary sources, limitations, confidence |
| [Search log](research/SEARCH_LOG.md) | Exact searches, retrievals, failures, research boundaries |
| [Source index](research/SOURCE_INDEX.md) | Local snapshots and original URLs |
| [Handoff validation](research/VALIDATION.md) | Link, source-integrity, citation, and plan checks; limits of what was verified |

## The project in one minute

**The question:** “Can I change my gateway, SDK, or model route without breaking my agent?”

1. Select a tool-using workflow and baseline/candidate Bifrost endpoints.
2. Replay a deterministic provider conversation through the actual gateways.
3. Compare protocol meaning: tool-call identity, argument completeness, stream termination, error propagation, and usage provenance.
4. Open the earliest observable divergence across client and mock-provider transcripts.
5. Reduce the failing conversation while preserving the same assertion failure.
6. Export a sanitized capsule, runnable Go regression test, and reviewable issue draft.
7. Paste the AI migration advice that motivated the change. Verify its time-sensitive claims against current official documentation with **Tavily Search/Extract** and model calls through **Bifrost**. Attach this separate evidence to the report.

The core distinction is the **reduction and test-export workflow**, connected to a deterministic protocol oracle. Bifrost already has logs, metrics, mocks, provider tests, and MCP chaos tests. RelayProof must reuse those capabilities and complement that work; it must not claim they are missing.

## Why this is the strongest choice found

- The hiring company explicitly values **Go, TypeScript/Next.js, developer tools, tests, documentation, and useful enterprise features**.
- Current Bifrost work includes streaming recovery, accurate interrupted-stream accounting, cross-protocol history conversion, MCP compatibility, governance, and routing. RelayProof produces useful artifacts in precisely those areas.
- Public hackathon repositories already contain convincing chaos-agent benchmarks, frozen-web research comparisons, freshness checkers, caches, and prompt-compression work. A generic version would face strong overlap.
- This project can demonstrate substantial behavior without buying large inference runs: the protocol lab uses **real Bifrost binaries and controlled mock upstreams**. Only the live evidence verifier needs Tavily and an LLM; an optional local model can provide the latter.
- It gives a maintainer something concrete to review: a small failing case and a passing regression test after a fix.

This is a research-based recommendation, not a guarantee of winning or a claim of worldwide novelty.

## Critical event facts

- Primary challenge: **Problem Statement 04 — Open-Source Bifrost Gateway / “Build a Feature the Open-Source Gateway Is Missing.”** A developer tool is expressly allowed.
- Integrated secondary challenge: **Problem Statement 06 — Stale-Answer Detector**. Its PDF requires meaningful use of **both Tavily and Bifrost**. The API-advice verifier must actually accept an LLM-generated answer, identify claims, retrieve live evidence, and return per-claim freshness assessments.
- **Prototype deadline: 15 November 2026, 11:59 PM as displayed in the event dashboard.** Browser-local timezone was not independently certified. Work to a **15 November, 6 PM IST internal cutoff**, and check the team leader’s countdown before uploading.
- **Judging: 29 November 2026, 7–11:59 PM as displayed.** Do not treat this as the build deadline or assume later code changes will be accepted.
- Public repository, working prototype, detailed README, and architecture/pitch materials are required by the submission instructions. Deployment is optional.
- The November 7 organizer announcement confirms **direct interview opportunities for winning Bifrost teams**; employment is not guaranteed.
- Current team: **vulcan**, two members. The logged-in account is a member; the leader is displayed as **Hydra Of Malice**.

## Existing submissions / deletion result

I inspected the account’s prototype-submission phase. The site displays:

> **Team Leader Access** — Only your team leader can create and manage submissions for this phase. You will be able to view once submitted.

**No project was deleted.** No existing submitted project details were visible to this member account, so their existence and titles could not be verified. The workspace was empty when research began. The leader must inspect the submission record, preserve anything worth retaining, and remove/replace the superseded submission through the site’s supported controls. Do not leave the team or attempt to bypass its permissions.

## Scope and working assumptions

- Build begins the morning of November 11; assume one primary builder and one teammate available for validation/presentation.
- The inspected machine is **ARM64 with 64 GiB RAM and 10 logical CPUs**. Go1.27.3, Node26.8.1, and pnpm10.18.0 are installed. Docker29.8.1 is installed, but its daemon/socket was unavailable during the read-only check; the build must start a supported runtime or use the documented native Bifrost binary. The proposed UI toolchain pins Node22. Local inference performance was not measured.
- P0 is a complete submission-quality prototype in approximately **38–48 focused engineer-hours**, with substantial uncertainty. P1/P2 add depth after the core loop works. Scope gates and fallback choices are explicit in the plan.
- No production interception, autonomous PR posting, deployment, or paid API use was performed for this research.
- Do not publish the research source archive wholesale: it includes private event-dashboard material and third-party source snapshots. Publish the new project and an attributed public bibliography instead.
