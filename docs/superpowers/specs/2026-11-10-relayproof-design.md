# RelayProof product specification

Version 1.0 · 10 November 2026 · implementation has not started.

## 1. Product decision

**RelayProof proves whether a gateway change preserves the behavior an agent depends on, and turns a failure into a regression test.**

The primary user is a Bifrost maintainer or platform engineer. They are changing a Bifrost version, routing an existing client to a different provider, or updating an SDK. A successful HTTP response alone does not establish compatibility. A tool identifier can be lost, a tool argument can be truncated, a conversation can contain an invalid role, or a stream can terminate without trustworthy usage.

The product’s one connected loop is:

**Migration advice → current-source claim audit → deterministic workflow replay → semantic difference → reduced reproduction → regression test.**

A user may enter at either the advice audit or the replay. Their evidence and test artifacts meet in the same compatibility report. Do not build unrelated chat, meeting prep, general research, deployment management, or production monitoring products alongside it.

### One-sentence pitch

“Before you switch models or upgrade your AI gateway, RelayProof turns your agent’s protocol assumptions into repeatable checks—and turns any failure into a tiny test a maintainer can run.”

### Primary and secondary challenge

- **PS04:** a practical developer tool integrated with standard Bifrost through supported HTTP/provider interfaces, with reproducible setup, documentation, tests, and an upstream-ready fixture/test contribution.
- **PS06:** accept an LLM-generated API answer, extract time-sensitive factual claims, check current official sources with Tavily, and return a freshness assessment for every relevant claim, using Bifrost for model calls.
- A protocol test result is **behavioral evidence**. A retrieved documentation passage is **documentary evidence**. Display them separately; a passing test cannot establish that a claim about every provider or version is true.

## 2. Goals and boundaries

### Goals

1. Detect concrete compatibility failures with deterministic assertions, including successful HTTP responses that carry broken semantics.
2. Exercise real Bifrost binaries without requiring private code or paid enterprise features.
3. Preserve enough wire evidence to locate the earliest observable divergence.
4. Reduce failing scenarios without breaking their protocol prerequisites.
5. Export artifacts a developer can run outside the UI and without an LLM key.
6. Verify API-migration advice against current official sources with explicit uncertainty.
7. Show excellent Go engineering and a clear TypeScript/Next.js developer experience.

### Explicit boundaries

- No promise of exhaustive API conformance or universal equivalence between model families.
- No comparison of different live model completions as if their text must match.
- No production traffic interception, system-wide proxy, eBPF capture, or TLS certificate installation.
- No autonomous code changes, PR posting, GitHub issue posting, deployment, account operations, or real tool side effects.
- No security testing against public services. Mutation injection happens only inside this local lab.
- No dynamic Go plugin dependency in P0. Runtime/module version coupling is unnecessary for a developer tool using public interfaces.
- No claims that replay, differential testing, delta debugging, or freshness verification are new inventions.

## 3. Users and jobs

| User | Concrete job | Useful output |
|---|---|---|
| Gateway maintainer | Reproduce a reported multi-turn conversion failure | Small scenario + captured wire + Go regression test |
| Platform engineer | Compare pinned gateway versions before an upgrade | Compatibility matrix and assertion-level differences |
| Agent developer | Preserve tool calls while changing a model route | A two-turn tool workflow that still completes |
| Engineer using AI advice | Check a possibly outdated API migration answer | Claim verdicts, official quotes, version/date scope, freshness score |
| Hackathon judge | Verify sponsor integration and implementation quality quickly | One-command lab, deterministic demo, exported test, live source audit |

## 4. The core user journey

1. **Open the workspace.** See whether Bifrost, the mock upstream, model route, Tavily, and artifact storage are available. Each capability has a separate status; an unavailable live verifier must not disable deterministic replay.
2. **Create an investigation.** Enter a title, baseline endpoint, candidate endpoint, and selected scenario pack. Default endpoints are local services from the supplied compose file; remote endpoints require an explicit server-side allowlist.
3. **Optionally audit the advice.** Paste the original LLM answer and an “as of” timestamp. It remains immutable. Highlight claims with exact source-text offsets. Display time sensitivity, source evidence, verdict, and limitations.
4. **Run the matrix.** Show each protocol, scenario, stream mode, seed, repeat, and actual endpoint version. Progress comes from backend run events.
5. **Open a failure.** A side-by-side timeline shows client request, mock-provider input, provider output, client stream, local tool result, and next turn. Highlight the exact assertion and earliest differing event. Use “first observed divergence,” not an unsupported root-cause diagnosis.
6. **Minimize.** Start from a copy of the original capsule. Show the number of valid candidates tested, rejected invalid reductions, bytes/messages removed, predicate result, and resource cap. User can stop. Original evidence is preserved.
7. **Export.** Download a manifest, redacted transcripts, fixture data, standalone Go regression test, curl request, and issue draft. Validate the archive before making it available. No external posting.
8. **Re-test a fix.** Import a capsule and rerun against a candidate endpoint. Both the original failing observation and the new result remain visible.

### Anchor demonstration

A support agent asks a model to call `lookup_order` with `{"order_id":"ord_1042"}`. A local deterministic tool returns a synthetic order status. The client sends that result back using the returned tool-call ID, and the mock origin returns a final response.

The clean gateway path preserves the identifier and the workflow completes. A **clearly labeled lab mutation** changes or drops that identifier in a candidate transcript. RelayProof detects the identity violation, identifies the event, removes unrelated history while preserving the tool pair, and exports a test that fails for the mutated case and passes for the clean one.

All names, orders, and tool outputs are synthetic. This is a demonstration of the detector, not proof of a bug in a released Bifrost version. A separate historical case can compare actual Bifrost versions if independently reproduced.

## 5. Features and priorities

P0 is the full prototype required for submission. P1 adds depth only after all P0 gates pass. P2 is post-submission direction, not a promise for judging.

| ID | Capability | Priority | Acceptance |
|---|---|---|---|
| F01 | Standard Bifrost integration | P0 | Pin v2.5.1; configure a local OpenAI-compatible mock provider; gateway handles actual HTTP requests |
| F02 | Scenario DSL and validation | P0 | Versioned JSON, strict size limits, explicit protocol and assertions; invalid tool dependencies rejected |
| F03 | Two client protocol paths | P0 | OpenAI Chat → OpenAI origin; Anthropic Messages → OpenAI origin; unary and SSE on each tested path |
| F04 | Stateful workflow driver | P0 | Executes a two-turn local tool workflow; validates server receipt of the matching tool result |
| F05 | Provider transcript recorder | P0 | Capture both sides of the gateway, stream frames, ordering, monotonic timing, and terminal status |
| F06 | Semantic oracle | P0 | Assertions for content, tools, arguments, roles, finish state, error state, and known/unknown usage |
| F07 | Differential run engine | P0 | Same immutable scenario on baseline/candidate; deterministic seed; repeated runs; resumable read-only results |
| F08 | Metamorphic stream checks | P0 | Chunk-boundary changes preserve reconstructed meaning; final-usage-only chunk remains accounted for |
| F09 | Mutation controls | P0 | Declared corruption transforms prove the detector catches identity, argument, terminal, role, and usage errors |
| F10 | Dependency-aware reducer | P0 | Remove irrelevant history/fields; preserve call/result dependencies and exact failure signature; bounded replays |
| F11 | Portable capsule and Go test | P0 | Export can be verified and rerun without UI, keys, or original workspace; no arbitrary embedded commands |
| F12 | API-answer freshness verifier | P0 | Real claim extraction through Bifrost + Tavily Search/Extract + quote validation + per-claim verdict/score |
| F13 | Investigator UI | P0 | Dashboard, matrix, run detail, reducer, advice audit, and export views with backend-driven state |
| F14 | Provenance and limits | P0 | Mode labels, known cost status, timeouts, concurrency, cancellation, credential redaction |
| F15 | CI checks and contribution pack | P0 | Meaningful tests + independent export check + public setup instructions + small upstream-ready fixture/test |
| F16 | Native Anthropic mock origin | P1 | Add reverse and same-family Anthropic mappings without widening core acceptance claims |
| F17 | Responses API adapter | P1 | A focused tool/usage path, with separate schema and fixtures; no claim of complete Responses coverage |
| F18 | Historical gateway comparison | P1 | One documented released-version regression reproduced with pinned binaries and an isolated origin |
| F19 | MCP retry/idempotency scenario | P1 | Local synthetic mutation only; ambiguous side effects classified, never reissued blindly |
| F20 | AI scenario suggestions | P1 | Model returns a strict draft DSL from verified evidence; deterministic validation and user review before execution |
| F21 | Bifrost trace/OTel correlation | P1 | Read documented logs/traces; correlate exact run IDs; no private SQLite schema scraping |
| F22 | HAR/log import, broader provider grid | P2 | Requires a separate import threat model and protocol coverage review |
| F23 | Production shadow replay / fleet control | P2 | Requires explicit authorization and safe handling of real data and side effects |

### Why both protocols are in P0

The key value is cross-protocol preservation, not an attractive wrapper around HTTP status checks. OpenAI → OpenAI is the oracle/control; Anthropic → OpenAI exercises real Bifrost conversion. Native Anthropic origin, Gemini, Bedrock signing, A2A, audio, and general MCP conformance are beyond the submission scope.

## 6. What the oracle checks

Assertions are versioned contracts, not LLM opinions. A result is `pass`, `fail`, `inconclusive`, or `unsupported`.

- **Tool identity:** every expected tool call has one identifier; IDs are unique in the relevant turn; results refer to the originating call. Match generated IDs by a bijection within an independent run, then require internal references to remain consistent. Never delete IDs from comparison as “noise.”
- **Arguments:** reconstruct partial tool arguments completely before JSON decoding; compare objects structurally, preserving string/number distinctions and array order.
- **Conversation validity:** required roles and call/result dependencies survive conversion according to the declared contract. Document intentionally dropped unsupported blocks.
- **Streaming:** arbitrary network chunks do not change semantic events; tool JSON fragments and UTF-8 splits reconstruct; terminal state is observed once; error termination is never presented as success.
- **Usage:** preserve provider-reported terminal usage where present; never sum cumulative counts; absent or interrupted usage remains unknown unless a separately labeled estimator supplied it.
- **Errors:** preserve a declared error class and terminal failure. An HTTP 200 stream may still fail. An expected refusal or expected 400 can be a passing **error-contract** test.
- **Output:** compare literal synthetic text/JSON where the mock controls it; do not byte-compare unrelated live model answers.
- **Unsupported behavior:** identify a route/capability as unsupported instead of failing every Bifrost version for a transformation it never promised to support.

A baseline can be wrong. Both versions are checked against the contract; “equal” and “correct” are different fields.

## 7. Freshness verification behavior

### Supported input

An LLM-generated answer about AI APIs or gateway migration, up to 12,000 characters. The user may paste model metadata and answer-generation time, but missing metadata must not be invented. The application’s current verification time is always recorded.

### Claim extraction

Use Bifrost-routed structured output to extract at most **8** claims. Every claim includes exact text, UTF-8 byte offsets, subject, asserted predicate/value, time sensitivity, and API/provider/version scope. Reject a claim whose offsets do not reproduce the input. Keep timeless claims visible as `not_time_sensitive` without spending retrieval credits by default.

### Evidence collection

- Search only allowed official documentation and official release notes for the claimed vendor.
- Search depth `basic`, `auto_parameters:false`, `include_answer:false`, `include_usage:true`, at most 5 results per query.
- Use at most 2 queries per claim, 16 searches per audit, and 8 extracted URLs total. Deduplicate across claims.
- `max_age_hours:0` requests fresh retrieval but is not a guarantee: cache mode, capacity failures, unknown date fields, and partial failures remain visible.
- Do not filter technical documentation by a recent publish-date window; a maintained reference page can have an old date. Record `retrieved_at`, source `published_at` if available, and `effective_from` only when supported by a passage.
- Extract actual passages. A search snippet alone is not accepted as decisive evidence.
- Parse both successful results and failed URLs even when Extract returns HTTP 200.

### Verdicts

`supported_current`, `outdated`, `contradicted`, `conflicting`, `unverifiable`, `not_time_sensitive`.

`outdated` requires evidence of temporal change or supersession. A false statement is not automatically stale. When current docs contradict a claim without proving it used to be true, use `contradicted`. Scope disagreement, missing effective dates, failed retrieval, and unsupported quotations can require `unverifiable`.

Each relevant claim returns:

- The original claim and scope.
- Verdict and plain explanation.
- Official URL, exact quote, passage offsets, retrieval date, and publication/effective dates when actually known.
- A **freshness score** and evidence coverage. The score is a documented support index, not a calibrated probability.
- A proposed corrected sentence only if supported by the accepted evidence; preserve the original answer separately.

Scoring is deliberately conservative and completely defined in the technical design. Mixed/unresolved claims have no numeric score and carry a reason. No answer-wide average that hides a critical unsupported claim.

### Concrete starter claims

Use a clearly labeled sample AI answer containing: “OpenAI stream chunks always contain complete usage, including after cancellation”; “Anthropic `message_delta` usage counts should be added across events”; and “Tavily Extract HTTP 200 means every URL succeeded.” Current inspected official sources contradict these blanket claims. A temporal verdict must still require evidence that the older claim was once valid. Include a fourth ambiguous version-dependent claim that the system should refuse to resolve without sufficient scope.

## 8. Screens and interaction requirements

Use a restrained developer-tool interface: readable tables, monospace payloads, clear state labels, reliable keyboard navigation, and one strong accent. Avoid decorative 3D, fake animated telemetry, dense novelty charts, or a marketing landing page that consumes build time.

| Route | Main content | Primary action |
|---|---|---|
| `/` | Capability status, recent investigations, getting-started steps | New investigation |
| `/investigations/new` | Endpoints, scenario selection, mode disclosure | Run selected cases |
| `/investigations/[id]` | Compatibility matrix, counts, baseline/candidate versions | Inspect failed assertion |
| `/runs/[id]` | Wire/event timeline, assertion inspector, evidence links | Minimize this failure |
| `/reductions/[id]` | Original/reduced payload, progress, preserved signature | Export verified capsule |
| `/advice/[id]` | Original AI answer, claims, quotes, verdicts, dates | Reverify or attach to investigation |

P0 can implement advice creation as a panel within an investigation. It does not need a separate chat UX.

### Important UX states

- No keys: replay works; evidence audit says what capability is unavailable.
- Bifrost unreachable: preflight failure with its endpoint and retry action; no fabricated pass rows.
- In progress: events and real counters; stop button and terminal cancellation state.
- Equal but invalid: comparison shows equality, oracle shows failure.
- Missing usage: `unknown`, never `$0` or zero tokens.
- Mutation: persistent badge on row, run detail, report, export, and screenshot.
- Reducer cannot make progress: return a verified non-minimized capsule and explain the cap or irreducibility.
- Live evidence unavailable: retain previous dated observation; never relabel it as current.
- Unsupported route: gray capability label and reason; exclude it from supported-case pass rate and show the excluded count.

## 9. Resources, stack, and privacy

### Fixed decisions

- Core: **Go 1.27.3**, standard `net/http`, `encoding/json`, `context`, `testing`; validate toolchain availability before pinning implementation.
- Gateway: **Bifrost HTTP v2.5.1**, pinned image/digest after download; default branch is not a release.
- UI: **Next.js 16.x + React 19.x + TypeScript 5.x**, Node 22 LTS, pnpm; resolve current patches once during bootstrap and commit lockfiles. If peer dependencies conflict, choose a compatible pinned set and record it rather than upgrading randomly.
- Storage: SQLite in WAL mode with a single writer, plus SHA-256 content-addressed artifacts.
- No Redis, Kafka, Kubernetes, vector database, Temporal, or multi-tenant IAM for P0.
- Optional local inference: Ollama behind Bifrost with a license-appropriate 7–14B instruction model first. Measure JSON/tool behavior before considering a 32B model. Do not hard-code a download or assume throughput from RAM.

### Default limits

Two concurrent scenarios; one reducer; 5-second connect timeout; 20-second unary call; 5-second stream idle timeout; 60-second scenario deadline; 120-second reduction deadline; 40 reduction attempts; 1 MiB input fixture; 10 MiB captured transcript per run; 8 claims and 16 searches per advice audit.

Live inference is **off until configured**. Enforce a configurable audit token cap and estimated-spend admission if reliable prices are available; also enforce a hard call cap when they are not. A token/spend cap cannot guarantee a provider’s final bill exactly, so retain provider usage provenance and reconcile after calls. No automatic paid benchmark sweep.

All services bind to loopback by default. Internal compose networking is explicit. Secrets are read server-side from environment references, redacted before persistence, and excluded from exports. Store synthetic data by default. Export requires a sanitation validation step. Treat retrieved docs as untrusted data, never as executable instructions.

## 10. Delivery tiers

### P0 submission, November 11–15

Two client protocols on the declared route set, 12 core fixtures, deterministic replay, semantic oracle, bounded reduction, standalone Go export, polished investigation UI, live advice verification, meaningful tests, evaluation report, README, demo, and contribution pack.

### P1 depth after P0 passes

Native Anthropic origin, one Responses path, one independently reproduced historical regression, more mutation testing, validated AI scenario suggestions, trace correlation, MCP side-effect safety fixture. Choose the one that most strengthens the measured demonstration. Do not attempt all of them.

### P2 product direction

Customer-owned captured sessions, protocol capability registry, broader providers, safe imported production traces, team collaboration, and opt-in CI integration. These need separate acceptance and privacy designs.

## 11. Release acceptance

1. A fresh checkout can start the lab through documented commands; prerequisites are explicit.
2. The replay engine actually crosses Bifrost’s documented routes; direct-origin calls cannot masquerade as gateway runs.
3. Both P0 client protocols complete the synthetic two-turn workflow in unary/streaming forms on the tested route set, or the final submission explicitly narrows its claims to a documented working subset.
4. The core fixture suite has genuine measured results, repeat counts, version identifiers, and unsupported/inconclusive counts.
5. Mutation controls demonstrate at least five failure classes and include clean controls.
6. A reduced case preserves the original signature and exports a Go test that compiles and reproduces outside the app.
7. The live advice verifier produces accepted official quotes and correctly handles uncertain and failed-retrieval cases with both sponsors actually involved.
8. No hidden mock fallback, default credential, production side effect, fake result, or auto-posting behavior.
9. A small, original contribution artifact is ready for maintainer review; upstream acceptance is not claimed.
10. Pitch, README, demo, and results agree with the actual implemented scope.

## 12. Main risks and predetermined responses

| Risk | Response |
|---|---|
| Existing Bifrost harness already solves most testing needs | Focus on portable case reduction/export; document exact reuse and incremental value |
| Cross-protocol behavior intentionally drops unsupported data | Use explicit capability/allowed-loss contracts; never assume universal preservation |
| A mock provider’s own output is invalid | Validate origin transcript before gateway scoring; make the oracle test itself against independent fixtures |
| No genuine gateway regression is found | Demonstrate declared mutations and clean controls; keep historical reproduction optional |
| Reducer changes the cause or invalidates the conversation | Stable failure signature, dependency closure, validity checks, and fresh isolated mock state per candidate |
| Web evidence is missing, stale, or contradictory | Abstain, show retrieval time/provenance, and keep behavior tests independent |
| UI consumes too much time | CLI/export first, then five focused views; cut decorative work and P1 |
| Four-day schedule is too tight | Freeze new protocols after Nov 12; prioritize the one complete end-to-end loop and document reduced scope |

The winning narrative must follow demonstrated evidence: **“Here is the broken assumption, here is the exact event, here is the smallest valid reproduction, and here is the regression test.”**
