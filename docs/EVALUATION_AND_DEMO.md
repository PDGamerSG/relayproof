# RelayProof evaluation and demonstration

This is a proposed evaluation protocol. **No RelayProof application, benchmark run, reproduced gateway defect, or live verifier result exists at the time of this research.** Implementation must replace plans with dated raw evidence before making performance or correctness claims.

## What must be demonstrated

1. A request crosses an actual standard Bifrost instance and reaches the scripted origin.
2. Independent assertions distinguish a correct control from a declared protocol defect, even with HTTP 200.
3. A smaller valid conversation retains the exact failure signature.
4. Its exported Go module compiles and reproduces independently of the application.
5. A real AI answer receives a live Bifrost + Tavily audit with exact official quotations and an honest uncertain case.

## Core scenario matrix

Use a fixed suite version, seed1042, pinned gateway/config hashes, and **three fresh repeats per case per lane**. Twelve cases ×2 lanes ×3 repeats = **72 scenario executions** before mutation/reduction experiments. A two-turn case includes two model HTTP requests; do not describe72 scenarios as72 HTTP requests or72 live model runs. Both baseline/candidate may use v2.5.1 for clean controls; declare the separate lab mutation rather than pretending a version upgrade caused it.

All origin data and tool output are synthetic. The suite consumes zero real model tokens; fixture usage numbers are protocol test data, separate from live analysis usage.

| ID / proposed file | Client | Mode | Contract and independent expected behavior |
|---|---|---|---|
| C01 `01-openai-unary.json` | OpenAI Chat | Unary | Two-turn `lookup_order`; consistent ID/reference, exact args, final text |
| C02 `02-openai-tool-stream.json` | OpenAI Chat | SSE | Tool arguments arrive across valid partial chunks; complete JSON and two-turn workflow survive |
| C03 `03-openai-terminal-usage.json` | OpenAI Chat | SSE | Final `choices:[]` usage is accepted; input41/output12 remain provider-reported for the relevant turn |
| C04 `04-openai-unicode-framing.json` | OpenAI Chat | SSE | UTF-8/escaped JSON, CRLF, comments, coalesced/split writes preserve semantic output |
| C05 `05-openai-interruption.json` | OpenAI Chat | SSE | Controlled interruption before usage leaves output usage unknown and terminal interrupted; no fabricated zero/success |
| C06 `06-openai-error.json` | OpenAI Chat | Unary | A scripted upstream429 with no gateway retries preserves a declared error class; expected error counts as contract pass |
| C07 `07-anthropic-unary.json` | Anthropic Messages | Unary | Bifrost conversion to OpenAI origin preserves tool-use ID/result relationship and final text |
| C08 `08-anthropic-tool-stream.json` | Anthropic Messages | SSE | Converted content blocks/tool JSON reconstruct into the correct call and result |
| C09 `09-anthropic-usage.json` | Anthropic Messages | SSE | Latest authoritative token fields survive; output count is not the sum of cumulative observations |
| C10 `10-anthropic-unicode.json` | Anthropic Messages | SSE | Unicode/escaped tool argument and varied origin byte boundaries preserve meaning |
| C11 `11-anthropic-stream-error.json` | Anthropic Messages | SSE | Scripted OpenAI-origin stream error becomes an explicit terminal failure under the declared conversion contract |
| C12 `12-anthropic-interruption.json` | Anthropic Messages | SSE | Interrupted converted stream never looks completed or carries invented complete usage |

For C09, record what the gateway actually emits. A separate hand-authored Anthropic codec fixture with cumulative counts4 then9 proves the parser returns9; do not pretend the OpenAI origin necessarily causes those two deltas. Likewise a mock's write boundaries do not guarantee identical downstream TCP boundaries: origin fragmentation tests and direct one-byte codec tests supply complementary evidence.

Preflight each capability against the pinned release. An intentionally unsupported conversion must be labeled unsupported with its reason; report the excluded denominator. A wrong expected contract must be corrected with an attributed reason, never quietly changed until a desired green score appears. An origin-invalid case is inconclusive infrastructure, not a gateway failure.

## Detector controls

Keep these under `suites/mutations/`, separate from clean suite totals. Run each control **three times**, paired with its identical no-mutation control. The five classes are15 injected runs and15 matched controls if executed separately; reusing a clean run requires referencing its actual run ID instead of counting it twice.

| Declared mutation | Boundary | Required signature family | Must not be confused with |
|---|---|---|---|
| `wrong_tool_result_id` | Recorded client/origin second-turn tool reference | `tool_reference_mismatch` | An actual Bifrost release defect |
| `truncate_tool_arguments` | Reconstructed controlled tool argument | `invalid_tool_arguments` or a predefined exact missing-value assertion | Network timeout or an invalid scenario input |
| `drop_terminal_event` | Controlled client stream capture before normalization | `missing_terminal` | Valid protocol-specific EOF termination |
| `drop_required_role` | Recorded outgoing provider message | `required_role_missing` | An intentionally supported non-message content block |
| `corrupt_usage` | Captured authoritative terminal usage | `usage_mismatch` | Legitimately absent usage after interruption |

Document the exact injection site. A transcript transformation tests detector sensitivity; it does not demonstrate Bifrost generated that malformed transcript. If a wire-level injector is added, label it separately. Mutation selectors are fixed outside reducer candidates so removing a field cannot silently disable the fault.

Also test a case where **both baseline and candidate are identically wrong**. The matrix may say semantically equal, but the oracle must fail both. This catches a common differential-testing false pass.

## Measurement definitions

Do not fill these with invented numbers. Store raw machine-readable observations, then derive the report.

| Measure | Definition / reporting rule |
|---|---|
| Applicable contract pass rate | Passed applicable runs / all applicable runs. Show fail/inconclusive/unsupported counts beside it; do not drop inconclusive runs silently |
| Detector sensitivity on controls | Injected runs with the expected target signature / injected runs attempted. Show infrastructure failures separately |
| False alarms | Known-correct matched controls incorrectly failed / valid matched controls |
| Deterministic repeat agreement | Repeats with identical oracle status/signature and canonical semantics / valid repeats, per case |
| Reduction preservation | Confirmed reductions with exact original target / reductions attempted. Include no-progress and failed-confirmation outcomes |
| Reduction size | `(original canonical JSON bytes − reduced canonical JSON bytes) / original bytes`; also show message/tool counts and both actual byte values |
| Reduction effort | Search attempts, invalid candidates, cache hits, confirmation runs, stop reason, wall time; three confirmations are additional executions inside the total deadline |
| Token reduction | Optional only with a named pinned tokenizer; byte reduction is not token reduction |
| Export reproducibility | Fresh-directory self-check passes / exports attempted; real-gateway passes, expected-failure reproductions, and skips reported separately |
| Latency | Actual monotonic end-to-end scenario/reduction elapsed time, sample count, median and range. With small samples avoid tail/SLA claims |
| Evidence quotation precision | Exact valid accepted quote spans / accepted quote spans. This checks quoting, not whether the model interpreted the passage correctly |
| Verdict quality | Per-class agreement with the small curated human-labeled set, confusion table, abstention rate, and source/date scope notes |
| Claim extraction | Exact-offset validity plus claim precision/recall against the manually defined atomic claims; note ambiguous decompositions |
| Cost | Actual Tavily returned credits and Bifrost analysis usage/pricing provenance; absent pricing stays unknown. Fixture tokens never become spend |

Planned release targets: all applicable clean contracts pass; all five controls detected with exact intended signatures; zero false failures in known-correct matched controls; at least one genuinely smaller, three-times-confirmed case; every published capsule self-check passes; live evidence quotes all validate. These are acceptance targets, not achieved results or broad statistical claims.

## Reducer evaluation

Use three padded cases (identity, terminal, usage) and one irreducible case. Preserve the original file and canonical hash. Give each reducer the same40 search-attempt/120-second cap and target assertion; reset the origin every execution. Confirm the final case in three fresh sessions.

Compare with two small baselines on the **same input**:

- No reduction: original size, zero attempts, unchanged predicate.
- Safe greedy unrelated-message removal: same validity checks, target, budget, and confirmations, without extra passes.

RelayProof's dependency-aware reducer need not beat the greedy baseline on every synthetic case. Show where it removes unused tools/fields and where structural dependencies prevent progress. Report a bounded local result; do not call it the smallest possible case. A timeout or unrelated error is never target preservation.

## Freshness-verifier evaluation

Create a small **16-claim curated set**, two examples for each row below. Label it from retrieved official passages and preserve the assessment date. Use eight claims for prompt development and eight for a held-out check; freeze prompts before inspecting held-out model outputs. This is a prototype sanity check with substantial uncertainty, not a general benchmark.

| Group | Expected treatment |
|---|---|
| OpenAI final usage and interrupted streams | Distinguish supported qualified statements from contradicted “always” claims |
| Anthropic cumulative usage and partial tool JSON | Preserve actual scope; avoid summing cumulative observations |
| Tavily Extract partial failures | HTTP200 alone cannot establish URL success |
| Exact named-version API behavior | Verify only the explicitly supported version; current retrieval does not invalidate old-version truth |
| Documented supersession | `outdated` only when an older supported claim and newer effective change are evidenced |
| Current contradiction without history | `contradicted`, not invented historical staleness |
| Conflicting official sources / missing version | `conflicting` or `unverifiable`, with null score and reason |
| Timeless/no-time-scope fact and retrieval failure | Skip irrelevant freshness scoring; failed relevant verification remains unresolved |

If an authentic supersession example cannot be found and sourced, mark that group unevaluated; use synthetic evidence only for deterministic policy tests, clearly labeled. Do not invent historical release passages. Keep the sample answer containing three false blanket claims labeled **synthetic AI-style sample** unless a real model actually generated it. For the live PS06 demonstration, generate or paste a real LLM answer and record its known model/time; an accurate answer with an uncertain claim is acceptable. A real answer need not contain a planted error.

For factual adjudication use exact quotes, vendor, version, temporal scope, and source freshness. The same model that proposed the verdict must not be the only evaluator. Ask the teammate to review the16 expected labels if available; otherwise disclose single-reviewer labeling. Include model outputs that were downgraded by deterministic gates.

## Independent and adversarial checks

Before submission, perform these practical checks and record pass/fail/not performed:

1. Fresh checkout following only the public README; no untracked configuration required.
2. Exported module run from a new directory with application binaries and model keys unavailable.
3. Wrong gateway URL and missing Tavily credential produce explicit unavailable/error states.
4. A document containing “ignore prior instructions” remains evidence text, never executable instruction.
5. Capsule with traversal/symlink/hash mismatch is rejected; missing usage stays unknown; mutation badge survives export.

A teammate can do these checks; no five-person user study is required for this deadline. Do not report independently reviewed work unless another person actually reviewed it.

## Three-minute demo script

| Time | Action | Evidence to show |
|---|---|---|
| 0:00–0:20 | State the upgrade question and PS04 developer-tool problem | Actual gateway version/config; local origin versus live analysis labels |
| 0:20–0:45 | Open a completed clean two-turn workflow and the paired declared mutation | Two independent oracle outcomes; HTTP200 is insufficient |
| 0:45–1:15 | Open the target assertion and first observed divergence | Tool ID/result reference, client and provider transcripts, stable signature |
| 1:15–1:45 | Run reduction from the padded case | Real attempts, removed bytes/messages, valid dependency graph, three confirmations |
| 1:45–2:10 | Export and run the standalone Go module from a fresh directory | Command output; self-check versus actual gateway mode clearly distinguished |
| 2:10–2:40 | Audit API advice using live Bifrost and Tavily | Original answer, exact official quotes/dates, a decisive and an uncertain claim |
| 2:40–3:00 | Show measured suite and small contribution artifact | Counts/limits, standard integration, original upstream-ready fixture/test |

Keep a dated backup recording of a completed live audit if the network fails during judging. Display its actual retrieval timestamp and `replayed_evidence`; do not describe playback as a live fetch. Core fixture replay should remain runnable without cloud keys. If reduction takes too long, show a previously completed reduction with its actual run history and run a smaller real case during the talk; disclose the switch.

Do not claim a genuine historical regression unless the team independently reproduced it with pinned affected/fixed releases. Public issue#9721 was closed by#9733; merely citing it is not reproduction. Issue#8983 concerns missing stream span usage when logging is off; its full end-to-end relevance was not tested in this research.

## Results report layout

The implementation should create `docs/RESULTS.md` with: execution date and commit; hardware/toolchain/gateway/config hashes; supported scope; raw artifact locations;72-run core matrix outcomes; control detection/false alarms; reduction table; export self-check/gateway outcomes; live evidence examples and held-out results; actual cost; failures/limitations. A section with no measured evidence should say **not evaluated**, with the reason. Do not publish the planning target as a result.
