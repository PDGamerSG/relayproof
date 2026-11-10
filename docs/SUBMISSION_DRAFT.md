# RelayProof submission and pitch draft

**Status:** Concept and implementation plan only. Rewrite these descriptions to match demonstrated behavior before submitting. No form has been submitted or previous project deleted by this research.

## Submission choice

- **Project name:** RelayProof
- **Primary:** PS04 — Open-Source Bifrost Gateway / Contributor Track
- **Integrated secondary:** PS06 — Stale-Answer Detector for AI Applications
- **Category:** Developer infrastructure / agent reliability
- **One-line description:** A Bifrost compatibility lab that reduces a broken agent conversation into a portable regression test and checks the API migration advice behind it against current official sources.

The November7 announcement permits an integrated project. Explain the single migration-investigation workflow; avoid pitching two separate products joined by a dashboard.

## Proposed short description

Upgrading an AI gateway can preserve HTTP success while breaking the agent's tool references, streamed arguments, terminal state, or usage accounting. RelayProof is designed to replay controlled multi-turn workflows through standard Bifrost, evaluate semantic contracts on both sides, reduce a failure without discarding its prerequisites, and export a standalone Go test a maintainer can inspect and run.

The same investigation can audit an LLM-generated migration answer. Bifrost manages claim-analysis requests; Tavily retrieves current official documentation. Exact quotations, version/time scope, per-claim freshness scores, and explicit uncertainty help engineers distinguish documented guarantees from assumptions. Behavioral observations and documentation evidence remain separate.

**Before submitting:** change “is designed to” to demonstrated present-tense behavior only for completed capabilities. State the actual protocol coverage, versions, counts, and limitations. Never imply that a declared lab mutation is a Bifrost bug.

## Problem, technical depth, and differentiator

**Problem:** Multi-turn agents depend on semantics that ordinary status-code checks or response text diffs miss. A large failing conversation is also expensive for a maintainer to diagnose. AI-generated migration advice can add unsupported assumptions about changing APIs.

**Depth:** Stateful protocol modeling; SSE framing across arbitrary byte boundaries; tool-call/result dependency graphs; independent correctness oracles; failure-preserving reduction; safe portable test generation; and quote/date/scope validation for live evidence.

**Differentiator:** Bifrost already has a provider harness, mocks, chaos tests, logs, and failure reports. RelayProof focuses on the next step: converting an observed failure into a small valid reproduction and reviewable regression artifact. Record/replay and delta debugging are established techniques; this project applies them to LLM protocol migration investigations rather than claiming to invent them.

## Sponsor integration statement

**Bifrost:** The compatibility engine sends real HTTP requests through pinned, standard Bifrost instances configured with a controlled OpenAI-compatible upstream. An independent provider receipt proves gateway traversal. All live analysis-model requests also route through Bifrost. No hidden direct-provider fallback is allowed.

**Tavily:** Search and Extract retrieve allowed official API references and release notes for time-sensitive claims in AI migration answers. The verifier handles per-URL failures, exact quote spans, retrieval dates, version scope, and contradictions. Search snippets alone cannot establish the verdict.

**Freshness score:** A documented ordinal support index:80/90/100 for increasingly specific accepted current support;0 for evidenced contradiction or historical supersession; null with a reason for unresolved/conflicting/timeless claims. It is not a probability. If a submission form requires a numeric value for every relevant claim, explain the abstention policy in the project materials rather than fabricating confidence.

## Six-slide pitch outline

1. **The migration that looked successful:** HTTP200, broken tool reference; show one synthetic workflow and concrete maintainer problem.
2. **One investigation loop:** advice audit → real-gateway replay → first divergence → valid reduction → standalone test.
3. **Architecture and sponsor roles:** client/origin boundaries, actual Bifrost instances, deterministic oracle, Tavily documentary evidence, Bifrost analysis route.
4. **Hard engineering:** byte-split stream reconstruction, cumulative usage, ID bijections, dependency-preserving predicate, capsule integrity.
5. **Measured proof:** actual core/control counts, reduction bytes, confirmation/export results, accepted quote and uncertain claim. Show denominators and modes.
6. **Contribution and next step:** small upstream-ready artifact, supported scope, limitations, one sensible extension. Include repo/demo and the team's roles.

No slide should say “first,” “guaranteed,” “production-ready,” “all providers,” or “won” without supporting evidence. Do not quote planning scores as organizer judging criteria.

## Public repository content

Publish the original implementation, licensed synthetic fixtures, reproducible configuration with empty secret references, lockfiles, tests, measured results, limitations, usage/demo documentation, architecture diagram, source bibliography, and contribution artifact. Choose a permissive license compatible with code actually reused; preserve required notices.

Keep the account dashboard archive, emails, invitation links, third-party repository snapshots, API keys, model weights, and local database/artifact directories outside the public repository. Cite competitors as prior work rather than copying their code or claims. Disclose AI assistance in the form or README where requested, with the team remaining responsible for testing and originality.

## Leader submission checklist

- [ ] Verify the leader's portal countdown/timezone; use November15,6 PM IST as the team's internal completion cutoff.
- [ ] Leader inspects any existing project record and uses supported controls to replace/remove the superseded submission. Research could not view one and deleted none.
- [ ] Title/track selection and description match the implemented scope and current event instructions.
- [ ] Public repository opens without login; default branch points to the intended commit. License, setup, README, architecture, tests, limitations, and actual results are present.
- [ ] Demo video and pitch links open for judges; no credential or private dashboard appears in the recording.
- [ ] Working prototype is reproducible. Deployment is optional; local prerequisites and hardware requirements are stated clearly.
- [ ] Both Bifrost and Tavily integrations are visible and real; replayed/mutated/offline/live segments are labeled.
- [ ] Claimed metrics can be traced to raw output. Unsupported cases and skipped integration checks are disclosed.
- [ ] Final form is saved/submitted through the leader's account, and the confirmation/receipt is verified.

This research did not publish, deploy, post a PR, send external messages, or submit the project. The logged-in member account is blocked by **Team Leader Access**; do not bypass permissions or change team membership.
