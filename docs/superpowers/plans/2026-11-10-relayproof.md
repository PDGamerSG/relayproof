# RelayProof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended by the planning skill) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **For this handoff, choose inline execution with executing-plans. The user has not requested delegated implementation.** Do not stop for routine design approval; make the documented choices and record evidence.

**Goal:** Build a working Bifrost compatibility investigation that produces a verified reduced failure capsule and standalone Go regression test, with a live official-source audit of AI API migration advice.

**Architecture:** A Go engine controls a scripted local origin behind two standard, pinned Bifrost instances. Deterministic protocol oracles evaluate both lanes; a bounded reducer replays valid smaller cases, and a portable exporter verifies their artifacts. Next.js presents the same local API; a separate Bifrost-routed analysis client and Tavily retrieve documentary evidence attached to the investigation.

**Tech Stack:** Go 1.27.3; Bifrost HTTP v2.5.1; Next.js 16.x, React 19.x, TypeScript 5.x, Node 22 LTS, pnpm; SQLite WAL and SHA-256 files. Resolve compatible patch versions once, commit locks, record any necessary departure.

**Spec:** [Product specification](../specs/2026-11-10-relayproof-design.md); [technical contracts](../../TECHNICAL_DESIGN.md); [evaluation](../../EVALUATION_AND_DEMO.md).

## Global constraints

- Build begins November 11; core freeze November 14; internal submission cutoff November 15, 2026, 6 PM IST. Confirm the portal's displayed November 15, 11:59 PM deadline with the leader.
- Primary PS04; integrated PS06. Live claim extraction/assessment uses Bifrost and live evidence uses Tavily. No silent direct-provider fallback.
- P0 clients: OpenAI Chat → OpenAI origin and Anthropic Messages → OpenAI origin, unary and SSE. Additional protocols are P1.
- Standard Bifrost, supported provider/HTTP configuration, separate baseline/candidate data. No core fork or dynamic Go `.so` plugin for P0.
- Two concurrent scenarios; one reducer; 5-second connect timeout; 20-second unary call; 5-second stream idle timeout; 60-second scenario deadline; 120-second reduction deadline; 40 reduction attempts; 1 MiB input fixture; 10 MiB captured transcript per run; 8 claims and 16 searches per advice audit.
- Two origin slots; one scenario per slot; reducer exclusively owns its slot. Never rely on a metadata field surviving conversion for origin isolation.
- Use `fixture_replay`, `injected_mutation`, `live_provider`, and `live_evidence` labels accurately. Injected defects are detector controls, not discovered Bifrost bugs.
- Preserve original inputs. Compare against independent semantic assertions; equal baseline/candidate output does not prove correctness.
- Reduction preserves the exact `FailureSignature`; invalid, timeout, unavailable-origin, and different-failure candidates cannot count as reproductions.
- Capsule imports execute validated data only. Exported code is inspectable; imports never execute code. No keys, arbitrary commands, absolute paths, or hidden network dependencies in capsules.
- Missing usage is null/unknown. Freshness scores are ordinal support indices, not probabilities. Search snippets cannot be decisive evidence.
- Loopback binds, explicit private networking, same-origin session protection, server-side credentials, redaction before persistence, and bounded jobs are part of P0.
- Public README, measured results, limitations, demo, and contribution artifact must describe what actually works. This document contains planned tests, not passing results.

## Execution and dependency map

Read the entire spec and technical design before Task 1. Track progress in `docs/STATUS.md`; append commands, failures, version pins, and measurements to `docs/BUILD_LOG.md`. Do not copy private account snapshots or competitors' implementation into a public release. Create an implementation directory `relayproof/` inside the existing private `PDGamerSG/relayproof` checkout; all paths below are relative to that application directory. Use the existing root Git repository, with no nested `.git`. A later public application repository must be created cleanly from the application directory, excluding this private archive and its Git history, when publication is authorized.

Core path: **1 → 2 → 3/4 → 5 → 6 → 7 → 8 → 9 → 12 → 13**. Evidence path: **2 → 10 → 11 → 12 → 13**. Execute sequentially in this session; these dependencies describe reusable boundaries, not a request to spawn agents.

| Area / files | Responsibility |
|---|---|
| `cmd/relayproof/main.go`, `cmd/mockorigin/main.go` | Command wiring only; no protocol logic |
| `internal/domain/{scenario,result,transcript,capsule,evidence}.go` | Public types; use names in technical design |
| `internal/scenario/{load,validate,dependencies}.go` | Strict load, validity graph, candidate validity |
| `internal/protocol/sse/reader.go`, `internal/protocol/{openai,anthropic}/*.go` | Byte framing and independent wire codecs |
| `internal/origin/{server,slots,script}.go`, `internal/driver/workflow.go` | Stateful synthetic origin and two-turn workflow |
| `internal/oracle/{evaluate,compare,signature}.go`, `internal/mutate/apply.go` | Independent assertions, comparison, declared controls |
| `internal/runner/{run,scheduler}.go`, `internal/reduce/{minimize,passes}.go` | Replay lifecycle, isolated candidate runs, bounded reduction |
| `internal/capsule/{sanitize,manifest,export,verify}.go` | Safe archive and standalone test export |
| `internal/store/{sqlite,artifacts,jobs}.go`, `internal/api/*.go` | Local persistence, durable events, HTTP/API security |
| `internal/evidence/{tavily,quotes,policy,audit}.go`, `internal/llm/client.go` | Live retrieval, evidence gates, Bifrost-only analysis |
| `web/app`, `web/components`, `web/lib` | Six focused routes, typed API, honest state rendering |
| `schemas`, `suites`, `testdata`, `integration`, `deploy`, `scripts`, `docs` | Schemas, fixtures, real integration, reproducibility, presentation |

## Task 1: Prove a real Bifrost → local-origin request

**Budget:** 2–3 hours, hard checkpoint by November 11 afternoon.

**Files:** Create `go.mod`, `Makefile`, `.gitignore`, `.env.example`, `deploy/compose.yaml`, `deploy/bifrost/baseline/config.json`, `deploy/bifrost/candidate/config.json`, `integration/bifrost_smoke_test.go`, `docs/BIFROST_INTEGRATION.md`, `docs/BUILD_LOG.md`, `docs/STATUS.md`.

**Interfaces:** Consumes the official custom-provider documentation and v2.5.1 configuration schema. Produces two working documented endpoint bases, provider alias `relayproof-origin/fixture`, exact client routes, image digest, zero-retry/cache settings, and a redacted request received by the local origin. The production `Driver` is not needed yet.

- [ ] Inspect installed `go version`, `node --version`, `pnpm --version`, `docker version`, and `docker compose version`; record exact results. Check the official release's actual image name and ARM64 support before pulling. Use the toolchain's current compatible patch if a proposed patch cannot be installed. Do not invent a tag or digest.
- [ ] Work inside the new `relayproof/` application directory of the existing private checkout and run `go mod init relayproof`; do not run `git init` there. Pin the working toolchain. Make `.env.example` contain variable names with empty values; ignore `.env*` except that example, `data/`, artifacts, and model downloads. The verified release image is `maximhq/bifrost:v2.5.1`; inspect/pull its ARM64 variant, pin its downloaded digest, and preserve release tag as provenance. Go1.27.3 is installed; Docker client29.8.1 exists but the daemon was unavailable during research. Node26.8.1 is installed, so select/install Node22 with the available version manager for this build.
- [ ] Write an integration test with an `httptest.Server` origin. It accepts only `POST /v1/chat/completions`, captures the body, and returns this independent wire fixture:

```json
{"id":"chatcmpl-lab","object":"chat.completion","created":1700000000,"model":"fixture","choices":[{"index":0,"message":{"role":"assistant","content":"gateway-crossed"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}
```

The test must send the client request to Bifrost, then assert both `gateway-crossed` in the client response and one matching origin receipt. Add an Anthropic-route probe with `anthropic-version: 2023-06-01`, `max_tokens:128`, and the same routed model. A no-gateway direct request is not a smoke-test pass.
- [ ] Run `RELAYPROOF_INTEGRATION=1 go test ./integration -run TestBifrostSmoke -v -count=1` before configuration is complete; confirm a meaningful connection/configuration failure. Configure supported provider base URL, lab key, allowed local network, routes, separate gateway directories, retries zero, and caching disabled. The technical design's JSON is a starting shape, not verified syntax. Inspect actual provider-received paths to resolve whether the base needs `/v1`; avoid `/v1/v1`.
- [ ] Repeat the integration command and capture actual versions/config hashes plus the redacted origin receipt. Document native-host and compose networking separately. If Docker is absent, build/use a standard release binary with the documented Go toolchain; do not spend the day installing an orchestration stack. If Anthropic cannot work within the budget, preserve the OpenAI route, file an explicit scope limitation, and continue the same product. Full two-protocol P0 remains unmet until tested.
- [ ] Commit the verified bootstrap with `git add .` and `git commit -m 'build: establish pinned Bifrost lab'`. Never commit a secret-bearing config.

**Gate:** At least one actual gateway crossing with an origin receipt; exact supported route/config known. Stop inventing application layers until this works.

## Task 2: Define strict scenarios and shared result contracts

**Budget:** 2–3 hours.

**Files:** Create `internal/domain/scenario.go`, `internal/domain/result.go`, `internal/domain/transcript.go`, `internal/domain/capsule.go`, `internal/domain/evidence.go`, `internal/scenario/load.go`, `internal/scenario/validate.go`, `internal/scenario/dependencies.go`, `internal/scenario/validate_test.go`, `schemas/{scenario,result,capsule,claim}.schema.json`, `suites/core/01-openai-unary.json`.

**Interfaces:** Copy `Protocol`, `Status`, `RunMode`, `Usage`, `ToolCall`, `Observation`, `AssertionResult`, `FailureSignature`, `OriginSession`, and interfaces exactly from the technical design into `internal/domain`. Define all other domain structs from that document before downstream work. Produce:

```go
func Load(r io.Reader, limit int64) (domain.Scenario, error)
func Validate(s domain.Scenario) error
func CanonicalBytes(s domain.Scenario) ([]byte, error)
func SHA256(s domain.Scenario) (string, error)
func RemoveMessage(s domain.Scenario, index int) (domain.Scenario, error)
```

These functions belong to `internal/scenario`; domain data is immutable by convention and copied before transformation. Add `LoadFile(path string) (domain.Scenario, error)` as an open/close wrapper over `Load` and `ValidationError{Code string, Path string, Message string}` implementing `error`. `Scenario.InitialMessages` is `[]Message`; `Message` contains `Role`, `Content`, `ToolCallID`, and `ToolCalls` with JSON tags. Define `Scenario.ID`, `ClientProtocol`, `OriginProtocol`, `Stream`, `Seed`, `Tools`, `OriginScript`, `ToolResults`, `Assertions`, `AllowedLoss`, and `Mutation` with the canonical JSON names in the technical design. Store provider-specific optional fields in a validated `json.RawMessage`, not arbitrary executable templates.

- [ ] Create a first fixture by copying the complete `lookup_order` scenario from the technical design. Add 8 unrelated synthetic historical messages so the later reducer has removable content. Keep the one user request, tool definition, call, result, and final response necessary to the target.
- [ ] Write this rejection test with actual invalid input; add separate tests for duplicate tool IDs, dangling results, unknown fields, >1 MiB input, multiple JSON documents, and unreachable script turns:

```go
func TestRejectDanglingResult(t *testing.T) {
    s, err := LoadFile("../../suites/core/01-openai-unary.json")
    if err != nil { t.Fatal(err) }
    s.InitialMessages = []domain.Message{{Role:"tool", ToolCallID:"missing", Content:"{}"}}
    err = Validate(s)
    var invalid *ValidationError
    if !errors.As(err, &invalid) || invalid.Code != "dangling_tool_result" {
        t.Fatalf("wanted dangling result error, got %v", err)
    }
}
```

- [ ] Run `go test ./internal/scenario -v` and observe the missing-loader failure. Implement bounded decoding with `io.LimitReader(limit+1)`, `DisallowUnknownFields`, an EOF check after the first value, protocol enums, schema version, required fields, and dependency/reachability validation. Return typed errors with a stable field path.
- [ ] Make canonical hashing preserve array order and use deterministic object-key serialization. Verify a copy with different object-key ordering hashes identically, while changed tool arguments do not. `RemoveMessage` must validate the resulting graph and reject a dangling call/result rather than manufacturing an invalid failure.
- [ ] Run `go test ./internal/scenario -v -count=1`; validate the good fixture and all rejection cases. Commit with `git commit -am 'feat: define strict scenario and result contracts'` after adding new files.

**Gate:** A valid human-readable case loads; malformed dependencies cannot reach the runner.

## Task 3: Parse streams independently of network chunk boundaries

**Budget:** 4–5 hours.

**Files:** Create `internal/protocol/sse/{reader,reader_test}.go`, `internal/protocol/openai/{request,unary,stream,stream_test}.go`, `internal/protocol/anthropic/{request,unary,stream,stream_test}.go`, `testdata/streams/{openai-tools,openai-terminal-usage,anthropic-tools,anthropic-error}.sse`.

**Interfaces:** Produce `sse.Event{Event string, Data []byte, Raw []byte}` and `sse.Read(context.Context, io.Reader, int, func(Event) error) error`. In each codec package produce `DecodeUnary([]byte) ([]domain.Observation, error)`, `DecodeStream(context.Context, io.Reader) ([]domain.Observation, error)`, and `EncodeRequest(domain.Scenario, []domain.Message) ([]byte, error)`. The observation schema and terminal/usage meanings come from the technical design; storage is not imported.

- [ ] Author raw SSE fixtures by hand from official wire contracts, independently of these encoders. OpenAI must include a final `choices:[]` usage chunk with `(41,12)` and `[DONE]`. Anthropic must include two `message_delta` cumulative output counts `4` then `9`, a tool JSON string split across events, and `message_stop`.
- [ ] Add a reader that returns one byte per read and this test pattern in each codec package; include all imports in the implementation test file:

```go
type oneByteReader struct{ r io.Reader }
func (r oneByteReader) Read(p []byte) (int, error) {
    if len(p) > 1 { p = p[:1] }
    return r.r.Read(p)
}
func TestOpenAITerminalUsageAcrossByteSplits(t *testing.T) {
    raw, err := os.ReadFile("../../../testdata/streams/openai-terminal-usage.sse")
    if err != nil { t.Fatal(err) }
    got, err := DecodeStream(context.Background(), oneByteReader{bytes.NewReader(raw)})
    if err != nil { t.Fatal(err) }
    last := got[len(got)-1]
    if last.Usage.Output == nil || *last.Usage.Output != 12 {
        t.Fatalf("lost terminal usage: %+v", last.Usage)
    }
}
```

- [ ] Run `go test ./internal/protocol/... -v` to confirm the unimplemented parser failure. Implement LF/CRLF framing, comments, multiline data, 1 MiB event limit, 10 MiB total, cancellation, EOF rules, complete-event JSON parsing, OpenAI choice/tool indices, and Anthropic block indices. Do not sum cumulative usage. Accumulate terminal observations so the final observation carries authoritative usage.
- [ ] Test a UTF-8 character split inside its bytes, escaped JSON strings, coalesced writes, empty tool fragments, unknown Anthropic event, HTTP-200 error event, truncated terminal sequence, malformed JSON, oversized event, and context cancellation. Expected protocol error/incomplete states must remain distinct from a valid completed observation.
- [ ] Run `go test ./internal/protocol/... -v -count=1` and `go test -race ./internal/protocol/...`. Commit as `feat: reconstruct OpenAI and Anthropic streams`.

**Gate:** Equivalent byte emissions give equivalent semantics; terminal usage and errors cannot disappear.

## Task 4: Execute an isolated stateful tool workflow through Bifrost

**Budget:** 3–4 hours.

**Files:** Create `internal/origin/{server,slots,script,server_test}.go`, `internal/driver/{workflow,workflow_test}.go`, `cmd/mockorigin/main.go`, extend `integration/workflow_test.go`, update `deploy/compose.yaml`.

**Interfaces:** Implement `domain.OriginController` and `domain.Driver` exactly. Constructors: `origin.NewServer(controlToken string) http.Handler`, `origin.NewController(baseURL, controlToken string, client *http.Client) domain.OriginController`, `driver.New(client *http.Client) domain.Driver`. Prepare's lane argument is `baseline` or `candidate`; it resets that slot atomically while holding its lease. `Transcript` returns both origin receipts and sanitized response frames. Only two slots exist in P0.

- [ ] Test a two-turn script directly against the origin using independent request JSON. Before the second request, the transcript must show one call; a mismatched `tool_call_id` must return a typed lab error and never a final success. A third request must be rejected as script exhausted.
- [ ] Run `go test ./internal/origin ./internal/driver -v`; confirm missing server/driver behavior. Implement `/slot/{lane}/v1/chat/completions`, `/v1/models`, and authenticated `/control/sessions` operations. Bind privately and keep control credentials out of provider request bodies and transcripts.
- [ ] Implement the driver: encode initial request; capture client bytes; decode assistant tools; execute only the allowlisted local `lookup_order` fixture; append assistant call and matching tool result in that client's wire format; perform the next request; return a combined transcript. Reject unknown tool names, invalid arguments, duplicate IDs, or more than the configured two-turn loop. Never execute arbitrary function names or shell tools from a response.
- [ ] Configure both Bifrost lanes to different slots. Send unique `x-bf-session-id` values, but use the configured slot for isolation. Assert that the origin receipt contains the prepared scenario hash and correct result reference. Test simultaneous baseline/candidate runs and attempted reuse of a leased slot.
- [ ] Run `RELAYPROOF_INTEGRATION=1 go test ./integration -run TestToolWorkflow -v -count=1` for both protocols and both stream modes. Record unsupported behavior accurately. Run origin/driver race tests, then commit `feat: replay isolated two-turn workflows`.

**Gate:** Client and origin evidence prove the same tool workflow crossed the actual gateway.

## Task 5: Add independent assertions and honest differential results

**Budget:** 3–4 hours.

**Files:** Create `internal/oracle/{evaluate,compare,signature,evaluate_test}.go`, `internal/mutate/{apply,apply_test}.go`, `internal/runner/{run,scheduler,run_test}.go`, `suites/mutations/*.json`.

**Interfaces:** `oracle.New() domain.Evaluator`; `oracle.Compare(baseline, candidate domain.Evaluation) domain.Comparison`; `mutate.Apply(id string, tr domain.Transcript) (domain.Transcript, error)`; `runner.New(origin domain.OriginController, driver domain.Driver, eval domain.Evaluator) *Runner`; `(*Runner).Run(ctx context.Context, ep domain.Endpoint, s domain.Scenario, mode domain.RunMode, mutationID string) (domain.RunResult, error)`. Define `RunResult` as transcript + evaluation + endpoint provenance; `Comparison` contains both oracle statuses, semantic equality, applicability, and first observed divergence. `Runner` is in package `runner`.

- [ ] Build an independent captured good transcript for `lookup_order`. Clone its data through JSON encode/decode in tests so mutation cannot modify the clean control. Inject five declared mutations: wrong result ID, truncated tool JSON, removed terminal event, removed required role in the recorded outgoing request, and corrupted usage. Record each injection site and mode in the transcript. These are transformations of a controlled lab boundary, not real released defects.
- [ ] Write an oracle test which requires **both** control pass and defect failure; compare exact signatures, not just aggregate fail status:

```go
func TestWrongToolResultIDIsDetected(t *testing.T) {
    s, err := scenario.LoadFile("../../suites/core/01-openai-unary.json")
    if err != nil { t.Fatal(err) }
    raw, err := os.ReadFile("../../testdata/transcripts/tool-good.json")
    if err != nil { t.Fatal(err) }
    var good domain.Transcript
    if err := json.Unmarshal(raw, &good); err != nil { t.Fatal(err) }
    eval := New()
    if got := eval.Evaluate(s, good); got.Status != domain.Pass { t.Fatalf("control: %+v", got) }
    bad, err := mutate.Apply("wrong_tool_result_id", good)
    if err != nil { t.Fatal(err) }
    sig, ok := eval.Signature(eval.Evaluate(s, bad))
    if !ok || sig.Code != "tool_reference_mismatch" { t.Fatalf("signature: %+v", sig) }
}
```

Use `scenario.LoadFile` from Task2 consistently in the CLI and tests.
- [ ] Run `go test ./internal/oracle ./internal/mutate ./internal/runner -v`; then implement assertions for origin validity, IDs/references, JSON arguments, roles, terminals, usage provenance, text, expected errors, and allowed-loss capability contracts. Invalid infrastructure is inconclusive. Preserve references while canonicalizing generated IDs bijectively; never normalize usage, errors, roles, or terminal markers away.
- [ ] Implement runner deadlines, slot lease cleanup, max concurrency two, repeat index, seed, mode, and immutable config/version provenance. Save first observed divergence with wire references. If the baseline and candidate both violate a contract, report equality plus two failures. If a feature is unsupported, show/exclude it explicitly.
- [ ] Run unit/race tests and the working real-gateway suite. A no-mutation v2.5.1-vs-v2.5.1 comparison must have no unexplained divergence. Commit `feat: evaluate semantic contracts and mutation controls`.

**Gate:** Five detector controls work; clean controls pass; equal output cannot mask an invalid contract.

## Task 6: Reduce a failure without changing its identity

**Budget:** 4–5 hours; working by November 12 evening.

**Files:** Create `internal/reduce/{minimize,passes,cache,minimize_test}.go`, `testdata/reduction/{padded-tool,irreducible}.json`.

**Interfaces:** Implement `Minimize(ctx context.Context, s domain.Scenario, target domain.FailureSignature, limits domain.ReduceLimits, reproduce domain.Reproduce) (domain.ReductionResult, error)` in package `reduce`. `ReductionResult` includes `Reduced domain.Scenario`, original/reduced canonical hashes and bytes, attempts, invalid candidates, signature, three confirmation records, stop reason, and `bounded_local` or `not_reduced`. The callback acquires an exclusive lane and resets it for each candidate.

- [ ] Use `padded-tool.json` with eight removable historical messages and the required tool workflow. Write a deterministic test callback that evaluates actual mutated transcripts with the same oracle; do not hard-code “fail whenever length > N.” The real-integration test uses `runner.Run` on each candidate.
- [ ] Assert these properties in `TestMinimizePreservesToolFailure`: reduced canonical bytes are fewer; `scenario.Validate(result.Reduced)` succeeds; all required calls/results remain; returned signature equals target; attempts ≤40; three fresh confirmations succeed. Also assert no reduction is accepted when the callback returns a timeout, invalid scenario, or a different assertion failure.
- [ ] Run `go test ./internal/reduce -v` to observe missing behavior. Implement the bounded passes from technical design: verify original; generate valid dependency-preserving removals; cache hashes; accept only the exact target; restart a successful pass; enforce attempts/deadline/cancellation; confirm best three times. Count confirmation executions separately from the 40 search attempts and inside the total 120-second deadline.

```go
func sameTarget(got domain.Evaluation, want domain.FailureSignature, eval domain.Evaluator) bool {
    for _, assertion := range got.Assertions {
        if assertion.ID != want.AssertionID { continue }
        targetOnly := got
        targetOnly.Assertions = []domain.AssertionResult{assertion}
        sig, ok := eval.Signature(targetOnly)
        return ok && sig == want
    }
    return false
}
```

When a transcript has several failures, deterministically select the target by assertion order and evaluate the target directly during reduction; an unrelated earlier assertion must not silently replace it. Record all assertions in the result.
- [ ] Test cancellation, repeated-hash elimination, irreducibility, failed confirmation, invalid original, and max-attempt exhaustion. Do not label an unconfirmed result verified. A non-shrinking but confirmed original can still export with `not_reduced`.
- [ ] Run `go test -race ./internal/reduce` and `RELAYPROOF_INTEGRATION=1 go test ./integration -run TestReduceThroughBifrost -v -count=1`; commit `feat: minimize valid failures with stable predicates`.

**Gate:** A real-gateway lab mutation becomes a smaller valid case with the exact preserved failure signature. If only a conservative subset-removal pass works, ship that honestly before adding text minimization.

## Task 7: Export a safe capsule and an independent Go test

**Budget:** 3–4 hours.

**Files:** Create `internal/capsule/{sanitize,manifest,export,verify,export_test,import_test}.go`, `internal/capsule/templates/repro_test.go.tmpl`, `internal/capsule/templates/README.md.tmpl`, `scripts/verify-export.sh`, `integration/export_test.go`.

**Interfaces:** Implement `BuildCapsule(context.Context, domain.CapsuleInput, string) (domain.Manifest, error)` and `VerifyCapsule(context.Context, string) (domain.Verification, error)` in package `capsule`. Additional `Inspect(ctx context.Context, archivePath string) (domain.Manifest, error)` validates data without executing exported code. `VerifyCapsule` is also data-only: it checks integrity/schema and the captured predicate with the host oracle. Only `BuildCapsule`'s private just-generated-template check executes Go, never code read from an imported archive. `CapsuleInput` contains scenario, oracle version, source/reduced transcripts, signature, reduction result, endpoint provenance, optional evidence, and sanitation profile. `Verification` distinguishes integrity, semantic predicate, generated self-check, gateway regression, and skipped states.

- [ ] Write an export integration test that creates a capsule, extracts it into `t.TempDir()` outside the implementation tree, and runs `go test ./...` there using `exec.CommandContext`. Generated code imports only standard packages and its own module `relayproof-repro`; it cannot import `relayproof/internal`. Explicitly check this property before executing trusted locally generated output.
- [ ] Add archive rejection tests for `../`, absolute paths, duplicate file names, symlinks, hash mismatch, >100 files, >10 MiB compressed, >50 MiB unpacked, and a 50 MiB+1 decompression bomb. Include an archive whose otherwise valid Go file has an `init` function writing a marker; neither `Inspect` nor `VerifyCapsule` may create the marker or execute a subprocess. Reject malformed artifacts before registration; creator/trust fields cannot authorize code execution.
- [ ] Implement sorted ZIP paths, exact file hashes, schema-versioned manifest, synthetic header/query redaction, consistent sensitive-ID replacement, and sanitation re-verification. If redaction changes the target signature or secret scanning remains unresolved, set `shareable:false` and return an export-blocked error. Preserve private evidence locally, separately.
- [ ] Generate a self-contained test that loads the scenario and captured contract, asserts the clean control passes, and asserts the labeled mutation is detected with the recorded signature. `TestGatewayRegression` is skipped without `RELAYPROOF_GATEWAY_URL`; with it, it starts/configures the documented local origin route and evaluates the actual gateway. Include optional env `RELAYPROOF_EXPECT_FAILURE=1` to assert a reproduced failing predicate. Default clean regression mode expects pass, so maintainers can observe a failing regression test on an affected gateway and a passing one after a fix. Test expected-failure mode is a verifier, not a claim that a broken gateway passed.
- [ ] For just-generated trusted templates, run the standard-library-only module with a minimal subprocess environment: `GOWORK=off`, `GOTOOLCHAIN=local`, `GOPROXY=off`, a private cache/temp directory, no provider secrets, and a30-second context deadline. Never reuse imported `.go` files in this check. Run `go test ./internal/capsule -v`, `RELAYPROOF_INTEGRATION=1 go test ./integration -run TestExport -v -count=1`, and the exported module's documented command from a fresh directory. Record exactly which gateway modes ran/skipped; commit `feat: export verifiable portable regression capsules`.

**Gate:** An independent module validates the capsule; it can exercise a documented standard gateway without application internals or model keys. No hidden gateway “pass” when the integration test was skipped.

## Task 8: Expose a usable CLI and complete the 12-case core suite

**Budget:** 2–3 hours.

**Files:** Create/extend `cmd/relayproof/main.go`, `internal/runner/suite.go`, `integration/cli_test.go`, `suites/core/01-*.json` through `12-*.json`, `scripts/doctor.sh`, `scripts/demo-core.sh`, `docs/CLI.md`, `Makefile`.

**Interfaces:** CLI commands call engine functions directly. Provide `doctor`, `run`, `reduce`, `export`, `replay`, `verify-capsule`, and later `serve`. Required flags: `run --suite --baseline --candidate --repeats --out`; `reduce --run --assertion --out`; `export --reduction --out`; `replay --capsule --endpoint`; `verify-capsule --file`. `--suite` accepts one strict case file or a directory; optional `run --mutation wrong_tool_result_id` applies the declared mutation to the candidate lane only. `run --out` writes a directory with a manifest and per-run immutable JSON files; `reduce --run` accepts one such file and `--out` writes the reduction JSON consumed by export. Exit codes:0 successful asserted result,1 valid failed assertion,2 input/config/infrastructure failure. `doctor` reports unavailable capabilities separately.

- [ ] Populate the exact 12-case matrix from the evaluation document using strict scenarios and independent expected assertions. Keep normal cases separate from mutation controls. A streaming-error fixture passes when the declared error contract is preserved; it is not a failed success case.
- [ ] Add a CLI integration test using built binaries that expects code 0 for a clean case, code 1 for a declared mutation, and code 2 for an invalid fixture or unreachable configured gateway. Assert stdout contains valid JSON when `--json` is provided, with human progress only on stderr.
- [ ] Implement argument parsing with standard `flag` subcommands and context cancellation. Resolve endpoint allowlists and key references server-side. `doctor` checks ports, binary/image version, config hash, storage, Bifrost analysis route, and Tavily configuration without echoing secrets or consuming credits by default.
- [ ] Run the complete CLI loop on a real Bifrost lane: run → inspect signature → reduce → export → verify → replay clean. Save artifacts and timing provenance. `make demo-core` must perform this loop, not print precomputed results.
- [ ] Run `go test ./cmd/... ./internal/runner/...` and `make demo-core`; commit `feat: provide reproducible CLI investigation workflow`.

**Gate:** A judge can use the core without the UI. This is the fallback demonstration if later UI work slips.

## Task 9: Add persistent jobs and the protected local API

**Budget:** 3–4 hours.

**Files:** Create `internal/store/{sqlite,migrations,artifacts,jobs,store_test}.go`, `internal/api/{server,investigations,runs,reductions,artifacts,jobs,security,server_test}.go`, `internal/api/openapi.yaml`, extend `cmd/relayproof/main.go`.

**Interfaces:** `store.Open(path string) (*Store, error)`; `(*Store).Close() error`; `api.New(store *store.Store, engine *runner.Runner, cfg Config) http.Handler`. `Config` includes UI origins, local session token, input limits, artifact root, endpoint allowlist, and max workers. Define storage methods alongside typed request/result structs; API routes and data fields must match technical design §12–13. Add `JobEvent{JobID string, Sequence int64, Kind string, Data json.RawMessage}` in domain and `AppendEvent(ctx context.Context, event domain.JobEvent) (int64, error)` on Store.

- [ ] Test `POST /api/v1/investigations` returns 202 plus investigation/job IDs and a job completes with a stored transcript hash. Add tests for bad origin, missing local session token, oversized body, wrong content type, private endpoint outside the explicit allowlist, and an artifact hash with a slash. None may launch a job.
- [ ] Run `go test ./internal/store ./internal/api -v`. Implement SQLite foreign keys/WAL/busy timeout, one writer queue, migration version, temporary-file-plus-rename artifact writes, and only then database references. Prefer a maintained pure-Go SQLite driver if it works with the pinned toolchain; pin its exact version. No external database service.
- [ ] Implement the documented routes, including data-only capsule import/replay, monotonic SSE event sequence/reconnect with `Last-Event-ID`, idempotent cancellation, endpoint preflight, and API error envelopes. The import route accepts bounded ZIP content under its own explicit content type/size limit; other POSTs require JSON. On restart, active jobs become interrupted. Never fabricate continuation of an interrupted stream; immutable finished artifacts remain queryable.
- [ ] Test SSE reconnect does not duplicate/drop stored sequence entries, cancel closes the origin lease, repeated cancel is safe, a restart marks an active job interrupted, and one corrupt artifact cannot be downloaded as valid. Keep GETs credential-free except for the local browser session protections; do not enable wildcard CORS.
- [ ] Run `go test -race ./internal/store ./internal/api ./internal/runner`; start `relayproof serve` on loopback and exercise one real HTTP investigation/export. Commit `feat: persist investigations and stream protected job events`.

**Gate:** A reload preserves results, and cancellation/restart does not leave a slot locked or misreport success.

## Task 10: Retrieve exact official evidence with Tavily

**Budget:** 2–3 hours.

**Files:** Create `internal/evidence/{tavily,quotes,tavily_test,quotes_test}.go`, `testdata/evidence/{extract-partial,extract-failed,conflicting}.json`, `schemas/evidence.schema.json`.

**Interfaces:** `NewTavily(client *http.Client, baseURL, credential string) *Tavily`; `(*Tavily).Search(ctx context.Context, query string, domains []string) (SearchResult, error)`; `(*Tavily).Extract(ctx context.Context, urls []string) (ExtractResult, error)`; `ValidateQuote(e domain.Evidence, q domain.Quote) error`. Define `SearchResult` and `ExtractResult` with successful sources, failed URLs, returned usage, retrieval mode, and errors; preserve both arrays for HTTP 200.

- [ ] Write quote tests that accept an exact UTF-8 byte slice and reject an invented quotation, a rune-index offset mistaken for a byte offset, a negative/reversed span, and the right text attributed to the wrong evidence ID. Never normalize source bytes before checking offsets.

```go
func TestQuoteUsesExactUTF8Bytes(t *testing.T) {
    e := domain.Evidence{ID:"e1", Text:"λ API remains supported."}
    q := domain.Quote{EvidenceID:"e1", StartByte:3, EndByte:6, Text:"API"}
    if err := ValidateQuote(e, q); err != nil { t.Fatal(err) }
    q.StartByte = 2
    if err := ValidateQuote(e, q); err == nil { t.Fatal("accepted wrong byte offset") }
}
```

- [ ] Test Tavily with `httptest.Server`: 200 with only `failed_results`, mixed successful/failed URLs, 429 with bounded `Retry-After`, authentication 401, timeout, and a forbidden domain returned despite a search filter. Assert request bodies use basic search, max5 results, no answer, explicit domains, auto parameters off, and usage on. Use `max_age_hours:0` where supported; an unsupported option is visible rather than silently treated as live retrieval.
- [ ] Run `go test ./internal/evidence -run 'TestQuote|TestTavily' -v`; implement bounded JSON/body sizes, server-side auth, one retry only on transport/429/5xx, domain/canonical URL checks, deduplication, exact extracted text hash, and separate retrieved/published/effective timestamps. A fetch-age request is not a publish-date filter.
- [ ] Perform one manually initiated live official-doc search/extract only when credentials are available through the host's secret mechanism. Record actual usage and HTTP/per-URL outcomes with keys redacted. If absent, retain deterministic client tests and mark live verification blocked; do not claim PS06 complete from fixtures.
- [ ] Commit `feat: retrieve and validate official documentary evidence`.

**Gate:** Every accepted quotation can be checked against stored exact text, and partial retrieval cannot become blanket success.

## Task 11: Audit an AI answer through Bifrost and deterministic evidence gates

**Budget:** 3–4 hours.

**Files:** Create `internal/llm/{client,client_test}.go`, `internal/evidence/{audit,policy,audit_test,policy_test}.go`, `internal/evidence/prompts/{claims,assessment}.txt`, `internal/api/audits.go`, `testdata/evidence/advice-cases.json`.

**Interfaces:** `llm.New(baseURL, model, credential string, client *http.Client) *Client`; `(*Client).JSON(ctx context.Context, system, input string, outputSchema json.RawMessage, maxOutputTokens int) (json.RawMessage, domain.Usage, error)`; `evidence.ApplyPolicy(claim domain.Claim, sources []domain.Evidence, proposed domain.ClaimAssessment, asOf time.Time) domain.ClaimAssessment`; `(*Auditor).Audit(ctx context.Context, answer string, generatedAt *time.Time) (domain.AuditResult, error)`; `NewAuditor(llm *llm.Client, tavily *Tavily, limits AuditLimits) *Auditor`. Define `AuditResult` with immutable answer/hash, claims/assessments, sources/failures, dates, usage, retrieval mode and limits; define limits from spec. These names are the API implementation contract.

- [ ] Test policy tables with actual expected outcomes: valid exact-scope source → supported80; independent second official source → supported90; explicit effective/version passage → supported100; documented supersession → outdated0; only current contradiction → contradicted0; conflicting official evidence → conflicting/null; unsupported quote or scope → unverifiable/null; timeless → not_time_sensitive/null. Do not let the proposed numeric score override this policy.
- [ ] Test the Bifrost client against a local stand-in **only for unit tests**. Assert every production analysis URL is the configured Bifrost base, no alternate provider URL is attempted after a failure, calls/output-token requests are bounded, original answer bytes remain unchanged, claim offsets match exactly, and one extraction repair is the maximum. A unit stand-in is never labeled a live sponsor integration.
- [ ] Run failing evidence/LLM tests. Implement extraction ≤8 claims, quote-backed assessment, per-claim query budget≤2, search≤16, extracted URLs≤8, audit≤90 seconds, LLM calls≤12, requested output tokens≤30,000. Validate domains/dates/scope deterministically and downgrade unsupported judgments. Instructions inside retrieved text never become tools or system instructions.
- [ ] Expose `POST /api/v1/audits`, `GET /api/v1/audits/{id}`, attachment to an investigation, source failures, and partial progress. Reverification creates a new dated audit while preserving the original answer. At report-view time, evidence older than24 hours receives `reverification_due`.
- [ ] Run `go test -race ./internal/evidence ./internal/llm ./internal/api` and one real Bifrost + Tavily audit of the four-claim sample. Save a recording, source hashes, accepted quotations, uncertainty, returned usage, and exact analysis model. Do not manufacture a live result if either key/capability is unavailable. Commit `feat: audit API advice with scoped freshness evidence`.

**Gate:** Both sponsors contribute to a genuine current-source audit. An uncertain claim is a useful demonstrated outcome, not a UI failure to hide.

## Task 12: Build the focused investigation UI

**Budget:** 4–5 hours; begin after the CLI export loop works.

**Files:** Create `web/package.json`, `web/pnpm-lock.yaml`, `web/next.config.ts`, `web/app/{layout,page,globals.css}`, `web/app/investigations/new/page.tsx`, `web/app/investigations/[id]/page.tsx`, `web/app/runs/[id]/page.tsx`, `web/app/reductions/[id]/page.tsx`, `web/app/advice/[id]/page.tsx`, `web/components/{CapabilityStatus,CompatibilityMatrix,RunTimeline,AssertionInspector,ReductionProgress,ClaimEvidence,ModeBadge}.tsx`, `web/lib/{api,events,types}.ts`, `web/tests/investigation.spec.ts`.

**Interfaces:** Generate `web/lib/types.ts` from the committed OpenAPI/schema contract; one typed API client exposes the routes in the technical design. Proxy same-origin `/api` to loopback Go, establish the local session token without embedding credentials, and use backend SSE events for progress. Component props consume generated types; do not invent a second result schema.

- [ ] Pin a compatible Next16/React19/TS5 set and Node22. Use the current design skills required by the implementation environment before creative UI work, with this spec as the approved direction. Start with a compact developer-tool layout, semantic table, accessible contrast, monospace payloads, keyboard focus, and textual status indicators.
- [ ] Add an end-to-end test for one real recorded investigation response: matrix → failed assertion → reducer → verified export link. Add separate tests for null usage rendering as `unknown`, persistent mutation labels, unsupported/inconclusive counts, failed retrieval, stale audit date, and cancellation. No invented percentage-progress timer.

```ts
test('unknown usage remains explicit', async ({ page }) => {
  await page.goto('/runs/usage-missing');
  await expect(page.getByTestId('usage-output')).toHaveText('unknown');
  await expect(page.getByTestId('mode-badge')).toHaveText('fixture replay');
});
```

Provide `/runs/usage-missing` via a deterministic API test fixture in the test environment only; production routes fetch actual IDs and never expose hard-coded demo records as measured results.
- [ ] Run `pnpm --dir web exec playwright test` before the views exist; implement the six routes, backend-driven counters/events, payload folding with byte limits, wire references, signature display, original/reduced comparison, downloadable artifact, validated capsule upload/replay, immutable answer highlighting, exact quotes with dates, and separate behavior/document evidence. Original answer highlights use byte-to-JavaScript-index conversion; test multibyte text explicitly.
- [ ] Test reload/reconnect, 390px/mobile and desktop widths, keyboard navigation, empty/no-key states, long JSON, and gateway outage. The matrix must retain applicable, failed, inconclusive, and unsupported counts instead of a misleading single green rate.
- [ ] Run `pnpm --dir web exec tsc --noEmit`, `pnpm --dir web build`, and the focused browser tests. Update `make demo` to start the real lab/API/UI with documented prerequisites. Commit `feat: present investigations and documentary evidence`.

**Gate:** A judge can understand the failure, reduction, and source evidence without reading logs; all displayed results come from actual backend artifacts.

## Task 13: Measure, package the contribution, and rehearse submission

**Budget:** 3–4 hours plus teammate review; freeze November 14.

**Files:** Create `scripts/evaluate.sh`, `scripts/verify.sh`, `.github/workflows/ci.yaml`, `docs/RESULTS.md`, `docs/LIMITATIONS.md`, `docs/DEMO.md`, `docs/CONTRIBUTION.md`, `contrib/README.md`, `contrib/tool-reference-regression.json`, public `README.md`, `LICENSE`, and final `docs/STATUS.md`.

**Interfaces:** `make test` runs meaningful core tests. `make verify` runs core/race checks, web typecheck/build, focused browser tests, a deterministic real-Bifrost integration gate when prerequisites exist, export integrity/self-check, and a supported secret scanner. `make evaluate` writes machine-readable raw results and a summary with every denominator/mode/version. A missing required integration is a disclosed unmet release gate, not a silently successful CI run.

- [ ] Run the evaluation matrix exactly as specified in `docs/EVALUATION_AND_DEMO.md`: clean/control cases, five mutation classes, fixed repeat count, bounded reductions, export in a fresh directory, and curated live advice cases. Preserve raw run IDs/hashes, elapsed timings, token/credit provenance, unsupported and inconclusive counts. Compute statistics from those files; do not type desired numbers into the report.
- [ ] Ask the available teammate to follow only the public README from a fresh checkout, inspect one exported test, and identify the mode of every demo segment. If unavailable, record the independent check as not performed and execute the clean-directory check yourself. This is a handoff test, not permission to message external people automatically.
- [ ] Inspect the current Bifrost harness layout and license. Translate **one original small scenario** into its supported fixture/test format, or produce a minimal clean adapter patch plus run instructions if that format cannot express the stateful test. Keep this contribution small. Document exactly which upstream commands were run; if not run, say so. No automatic issue/PR posting or acceptance claim.
- [ ] Run `make verify`; resolve failures, rerun only affected checks, and record the final full release gate. Scan tracked files and capsule contents for secrets/private snapshots. Ensure no `.env`, participant email, chat invite, competitor source archive, fabricated metric, or hard-coded successful “live” fallback enters the public repository.
- [ ] Rehearse the three-minute script; record an uncut working core plus live evidence segment, retaining timestamps and provenance. Rewrite submission copy from actual features/results, include AI assistance and source/license attribution as required, and give the team leader repo/video/pitch URLs and replacement instructions. Use the supported leader UI to submit only when authorized. Commit `docs: publish measured results and contribution pack`.

**Gate:** Public artifacts are reproducible, honest, and ready for leader submission. Research or planning alone does not meet this gate.

## Four-day allocation and fixed scope cuts

The task ranges overlap in difficulty; the **38–48 focused primary-builder hours** estimate assumes strong Go/TypeScript familiarity, code assistance, and a teammate handling 6–10 hours of independent setup/demo/document checks. Sum the actual work, not the optimistic lower bound. This is an aggressive prototype estimate with substantial integration risk, not a production delivery promise.

| Date | Required outcome | Approximate primary-builder allocation |
|---|---|---:|
| Nov11 | Actual Bifrost integration; strict schema; stream parsers; first tool loop | 10–12h |
| Nov12 | Oracle, controls, reducer, first independent export | 10–12h |
| Nov13 | Persistent API; live evidence verifier; UI shell | 10–12h |
| Nov14 | Complete UI; measured suite; contribution; demo/docs | 8–12h |
| Nov15 | Fix release blockers; upload and verify assets before internal cutoff | Buffer, no new features |

Apply cuts in this order when a checkpoint slips:

1. Remove every P1 feature, AI explanations of failures, decorative charts, live-provider benchmarking, and optional local-model experiments.
2. Use a single investigation screen with drawers for run/reduction/advice rather than independently polished views; preserve the same URLs/contracts where practical.
3. Keep a conservative dependency-aware message/tool subset reducer. Cut advanced text/argument shrinking before cutting reproducibility or confirmations.
4. Keep two lanes on the same pinned v2.5.1 image with separate config and a declared mutation. A real historical released regression is optional and must never be fabricated.
5. If a cross-protocol route is unworkable, release an explicitly narrowed OpenAI unary/SSE prototype with the full reduction/export/evidence loop. Update all coverage statements and acknowledge that original two-protocol P0 was not achieved. Do not quietly call the full specification complete.

Never cut exact target preservation, an independently verified export, authentic Bifrost traffic, source quote validation, mode labels, credential protection, or the working PS06 audit to add breadth.

## Spec coverage audit

| Requirement | Tasks |
|---|---|
| F01 standard install; F14 networking/limits | 1, 4, 5, 9 |
| F02 strict DSL; F04 workflow; F05 transcripts | 2, 4 |
| F03 two client routes; F08 stream invariance | 1, 3, 4, 8 |
| F06 oracle; F07 differential/repeats; F09 controls | 5, 8, 13 |
| F10 valid bounded reduction | 6 |
| F11 safe portable capsule/import/retest | 7, 8, 9 |
| F12 live claim verification and scoring | 10, 11 |
| F13 UX, dates/nulls/modes/cancellation | 9, 12 |
| F15 CI, original contribution, evaluation | 7, 13 |
| P1/P2 boundaries | Explicitly excluded until all P0 gates pass |

Completion evidence belongs in the implementation's build log and results report. Checkbox marks in this plan must follow verified work, not anticipated success.
