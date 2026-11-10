# Claude: implement RelayProof from this handoff

Copy this instruction into Claude with this directory attached or opened as the workspace:

> Build **RelayProof**, the Bifrost upgrade and compatibility lab specified here, for the Geek Room Global AI Hackathon. The idea-selection and research phase is complete. Proceed with implementation without asking me to choose an idea, tech stack, naming direction, or routine architectural details.
>
> Read these files in order:
> 1. `README.md`
> 2. `research/RECOMMENDATION.md`
> 3. `docs/superpowers/specs/2026-11-10-relayproof-design.md`
> 4. `docs/TECHNICAL_DESIGN.md`
> 5. `docs/EVALUATION_AND_DEMO.md`
> 6. `docs/superpowers/plans/2026-11-10-relayproof.md`
> 7. `docs/SUBMISSION_DRAFT.md`
>
> Implement P0 task by task, running each task’s acceptance checks before continuing. Default to inline execution; use delegation only if I explicitly request it or a governing workspace instruction requires it. Keep a short `docs/BUILD_LOG.md` with completed tasks, commands, failures, actual version pins, and measured results. Maintain `docs/STATUS.md` as the coverage checklist. Make routine choices yourself. Ask only for an unavailable secret or a genuinely blocking external fact. Do not invent credentials or mark a failed capability as working.
>
> The workspace is the private GitHub repository `PDGamerSG/relayproof`. Put application files in its `relayproof/` subdirectory and use the existing Git repository; do not initialize a nested repository. The implementation's `docs/BUILD_LOG.md` and `docs/STATUS.md` live under that application directory. Keep this research repository private. A later public application release must be a separate clean repository that excludes the private archive and its Git history.
>
> Use **Go** for the protocol engine, CLI, mock provider, reducer, verifier orchestration, and local API. Use **TypeScript + Next.js** for the UI. Use **SQLite + content-addressed files** for local state. Keep Bifrost as an unmodified, pinned service connected through documented provider configuration and HTTP routes. Avoid dynamic `.so` plugins for the core release. All production LLM calls, including extraction and explanations, must pass through Bifrost; Tavily calls remain server-side.
>
> The primary track is **PS04 Open-Source Bifrost Gateway**. The secondary integration is **PS06 Stale-Answer Detector**, specialized to AI API migration advice. It must accept a real LLM answer, extract potentially stale claims, retrieve current official sources with Tavily, validate quotations, provide explicit verdicts and per-claim freshness assessments, and attach them to a compatibility report. A generic documentation search tab does not satisfy PS06.
>
> The first working slice is: launch a real Bifrost v2.5.1 instance, point an OpenAI-compatible custom provider at the local mock upstream, run one two-turn tool workflow, validate the round trip, apply a declared lab mutation, detect its assertion failure, reduce the case, and export a standalone Go test that reproduces it. Build the polished UI after that works from the CLI.
>
> Keep separate labels for **fixture replay**, **injected mutation**, **live provider**, and **live evidence**. A mock origin behind a real gateway is not a live model. Never manufacture benchmark numbers, present mutation results as Bifrost vulnerabilities, treat search snippets as proof, or let an LLM decide deterministic protocol pass/fail. Replays re-execute captured inputs; they do not rewind arbitrary agents or make new model output deterministic.
>
> The public prototype deadline is **November 15, 2026, 11:59 PM as displayed**. Finish the core by November 14. Use November 15, 6 PM IST as an internal submission cutoff and verify the leader’s countdown. November 29 is judging, not the development deadline. If behind, follow the plan’s explicit scope cuts; preserve the full failure → reduction → regression-test loop and a real PS06 verifier before adding extra protocols.
>
> The existing account is a member of team `vulcan`. The portal blocks submission management behind **Team Leader Access**. Research did not delete any project and could not see an existing submission. Do not bypass access or change team membership. Give the leader the completed repo, pitch, and demo assets to replace the old submission through the website.
>
> Do not publish this research archive or other teams’ code. Create original implementation. Attribute prior work and any reused licensed examples. Prepare a public-ready project, clean README, reproducible fixtures, evaluation report, demo video script, and potential upstream contribution patch. Do not send emails, post issues/PRs, deploy, or submit the form until separately authorized.

## Completion contract

Claude should hand back a working repository with:

- `make demo`: real pinned Bifrost integration, local mock upstream, API, and UI.
- `make test`: meaningful protocol, reducer, quote-validation, and artifact tests.
- `make verify`: tests, race checks for the Go core, UI typecheck/build, export verification, secret scan, and deterministic replay checks.
- A 12-case core suite with repeated deterministic runs and declared mutation controls.
- A tested two-protocol slice: P0 acceptance requires OpenAI Chat and Anthropic Messages on the declared route set. If a route cannot be supported, disclose the narrowed release and preserve unary/streaming on the working route; the original full P0 remains unmet.
- One reduced failure capsule whose exported test compiles and reproduces the assertion independently.
- A live Tavily + Bifrost verification recording on API-related claims, including an uncertain case, with the original AI answer preserved.
- A supported, reviewable integration with a standard Bifrost install and a small upstream-ready artifact, even if maintainers have not reviewed or accepted it.
- Actual results, complete limitations, an approximately three-minute demo, and submission copy edited to match the final implementation.

The detailed documents resolve edge cases. If they conflict, apply this precedence: user instructions → event mandatory requirements → product-spec P0 acceptance → technical contracts → task plan. Record the correction and continue.
