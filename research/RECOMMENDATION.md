# Recommendation and research findings

**Build RelayProof: a Bifrost upgrade and compatibility lab with failure reduction, regression-test export, and current-source verification of AI migration advice.** Choose the **PS04 contributor track**, with **PS06 stale-answer verification** as the coherent Tavily integration.

Research date: 10 November 2026. Sources are mapped in [EVIDENCE_MAP.md](EVIDENCE_MAP.md). The [search log](SEARCH_LOG.md) records the exact queries and retrieval limits. This was a bounded public-source and authorized account investigation, not an exhaustive census or private-company roadmap review.

## 1. What the event actually asks for

The event is the **Geek Room Global AI Hackathon hosted on HackCulture**, not Hack-Nation’s similarly named event. It publishes six detailed PDF briefs, all downloaded and extracted in `research/sources/theme-*.pdf` and `.txt`.

| Challenge | Non-negotiable substance | Assessment for this team |
|---|---|---|
| PS01: Token-efficient coding agent | Real code tasks, failover, pre-call budgets, local-only confidential repos, explicit approval for writes/shell/Git | High engineering value, but mature competitors and large agent/security surface |
| PS02: Agent benchmark platform | Framework independence, identical tasks, repeated runs, success/steps/tools/tokens/cost/time, controlled failures, inspection | Good fit but several existing entries already cover most of this thoroughly |
| PS03: Autonomous pentest agent | Unknown organizer lab target, real tools, autonomous decisions, strict scope, objective completion, evidence report | Lab availability and unknown-target generalization make delivery risk high |
| **PS04: Bifrost contribution/developer tool** | Real operational gap, supported interfaces, standard installation, tests/docs, upstream-quality artifact | **Best fit for a Go protocol reduction/export tool** |
| PS05: Pre-meeting research | Company/person + meeting time, previous 30 days, one-page brief, sourced findings/questions | Coherent but common; less distinctive for the stated hiring objective |
| **PS06: Stale-answer detector** | Identify sensitive claims, current-source verification, per-claim freshness, both Tavily and Bifrost | **Useful within migration investigations; heavily crowded as a standalone product** |

The site’s November 7 announcement confirms $1,000 Bifrost cash prizes and direct interview opportunities for winning teams. Earlier announcements, general rules, and current submission instructions disagree about whether one or two projects are expected. The most recent specific announcement permits one project, one per track, or an integrated project. **One integrated PS04 + PS06 submission is consistent with the shared requirements and avoids depending on the two-project exception.** [S01, S02, S03]

The current prototype deadline is **November 15 at 11:59 PM displayed**, with judging November 29. The countdown is the operational source of truth; do not infer that the whole November 29 event range is build time. The published judging criteria are **innovation, technical execution, problem and potential impact, use of AI, user experience, and scalability/potential**. No numerical weights or named judging panel were found on the inspected page. [S01]

## 2. Submission management result

The logged-in account is a member of `vulcan`, a two-person team. The team page identifies **Hydra Of Malice** as leader. The submissions phase shows **Team Leader Access** and says only the leader can create/manage submissions; a member can view once submitted. No existing project record was visible.

Therefore **no submission was deleted**, and there is no evidence here of what was previously submitted. This is an observed site permission limit, not a missing confirmation request. Do not attempt API permission bypass, leave the team, delete a teammate, or delete unrelated local repositories. The working directory was empty at the start. [S04]

## 3. What Maxim / Bifrost is working on

### Public product direction

- **Bifrost gateway:** unified model access, retries/fallbacks, routing, caching, budget/governance, telemetry, and SDK compatibility. These are existing features, not opportunities to re-create under a new name. [S05, S06]
- **Agent Gateway:** an October 20, 2026 launch connects A2A agents with model/MCP work, access controls, conversation logs, transport bridging, and correlation. Dhwanil Pithva’s launch article names `x-bf-session-id` and `x-bf-agent-correlation-id`. This increases the importance of preserving multi-step protocol state. [S07]
- **Bifrost Edge:** publicly presented endpoint coverage for enterprise AI traffic across desktop/browser/coding tools, governed through Bifrost. It is an existing product direction; a shadow-AI desktop proxy would overlap and add substantial platform scope. [S08]
- **Maxim Evals:** already offers agent simulation, end-to-end evaluation, dashboards, synthetic/production datasets, CI workflows, SDKs, and enterprise deployment. A generic evaluation dashboard would overlap with the sponsor’s own platform. [S09]

### Concrete current engineering signals

The latest release inspected was **Bifrost HTTP v2.5.1**, published **November 10, 2026**. Its release notes cover invalid/empty chat messages, null Gemini request/response entries, and panic recovery in streaming provider/plugin paths, including terminal errors and logging/billing. It identifies separate core `v1.15.2` and framework `v1.12.2` dependencies. [S10]

Recent merged activity includes:

- Preserving prompt-cache-related request serialization for Vertex Claude.
- Converting server/MCP history without emitting roleless Chat messages.
- Recording estimated usage for cancelled streams with estimation provenance.
- Provider/speech/realtime protocol work.
- UI error behavior that distinguishes missing assets during upgrades from unrelated network blocking. [S11]

Open PRs inspected on November 10 include named model routers, model-routing rules, complexity/phrase suggestions, governance budget reconciliation, and provider integration work. These are **public proposals or in-progress contributions**, not guarantees of future releases. [S12]

### Existing infrastructure that RelayProof must acknowledge

1. The published provider harness already lists **725 requests**, protocol/provider feature matrices, live calls, HTML failure reports, and an interactive viewer with **Resend + Copy curl**. Merely adding another test table is not enough. [S13]
2. The repository already has a mocker plugin and programmable MCP chaos infrastructure. PR #9082 provides a controllable mock fleet; related tests cover sessions, tool changes, errors, transport behavior, and governance. RelayProof should use the patterns and contribute compatible small fixtures rather than claiming to introduce testing or chaos to Bifrost. [S14]
3. Logs, Prometheus metrics, OTel support, custom dimensions, and compatibility transformations already exist. The research README advertises different performance numbers across surfaces; this report does not treat any marketing latency claim as independently measured. [S05, S06]
4. Native Go plugins have exact compiler/module/dependency/platform coupling. Supported provider configuration and HTTP interfaces are a lower-risk integration for this tool. [S15]

**The gap selected is a product hypothesis:** a convenient, protocol-aware way to **reduce an observed failing conversation and export a self-contained regression artifact**, with honest evidence about current API advice. The inspected materials did not establish that this complete workflow is already shipped. Search absence does not prove nobody has built it.

## 4. What public team members are working on

Only public professional profiles, authored articles, commits, and PRs were used. Activity is a snapshot of observable contributions, not an account of everything a person does internally. GitHub contributors are not automatically employees.

| Person | Verified public relationship | Observed professional work | Relevance |
|---|---|---|---|
| **Akshay Deo** (`akshaydeo`) | GitHub bio: cofounder/CTO, `@maximhq` | Release author; current serialization, cost, streaming and core changes; code integration | Strong Go correctness, usage accounting, reproducible failures |
| **Pratham Mishra** (`Pratham-Mishra04`) | GitHub bio: founding engineer at Maxim AI | Nov 2–7 MCP log UX, tool-sync and auth/per-user-discovery tests, chaosmock bridge, isolation | Useful test artifacts plus clear developer UX matter |
| **Suresh Chaudhary** (`impoiler`) | GitHub bio: founding engineer at Maxim, building Bifrost | Current dashboard upgrade/network errors; provider integration and harness contributions | Integration polish and diagnosable failure states |
| **Dhwanil Pithva** (`danpiths`) | Official workshop announcement: founding engineer; official Agent Gateway article author; GitHub README links alias to real name | Agent Gateway launch and public full-stack/Next.js work | End-to-end traces, agent protocol transitions, high-quality UI |
| **Tejas Ghatte** (`TejasGhatte`) | GitHub company `@maximhq` | Vertex speech and ElevenLabs realtime/Scribe translation commits | Protocol fidelity and stream state are practical concerns |
| **Anuj Parihar** (`BearTS`) | Public bio: Bifrost maintainer/backend; employment not inferred solely from this | Open governance budget/reconciliation/UI proposals | Budgets and honest cost/usage semantics |
| **`vrivri` / `kohlivrinda`** | GitHub company `@maximhq`; MLE bio; full name not confirmed | Current complexity-router phrase suggestion/scheduling/settings proposals | Routing changes need validation; no claim of internal roadmap |
| **Swaponeel** | Workshop announcement identifies a GTM engineer; full identity not independently established here | November 5 Bifrost workshop co-presenter | Communicate the project’s operator problem clearly |

Sources: [S11, S12, S16, S17]. Use the displayed profile names/handles; do not infer a person's full identity from a username.

The hiring role inspected is unusually useful evidence: **Member of Technical Staff**, Bangalore, describes OSS maintenance/contributions, enterprise features, maintainable Go, databases, thoughtful UX, external developer tools, and shipped AI projects. Its stack is explicitly **Go primary; TypeScript + NextJS secondary**. This is a stronger reason to use Go than matching a fashionable architecture. The role lists 2–4 years of experience; the hackathon does not waive hiring requirements. [S18]

## 5. Tavily and other partners

Tavily’s October 2026 update, by **Stefanie Miller**, emphasizes fresh web context, fetch-age controls, optional EU query processing/retention, integrations, and company-search benchmarking. It identifies **Ricky Johnson** as DevRel presenting practical CLI/plugin/agent workflows. Nebius’s May 20 article states it has acquired Tavily and positions inference plus live retrieval as production-agent building blocks. Named authors **Jakki Jakaj** and **Dylan Bristot** communicate that integration publicly; this is evidence of published work, not access to engineering assignments. [S19, S20]

The API docs expose an important distinction for our project: **publish date** and **age of cached fetched content** are different. `max_age_hours` requests fetch freshness; old published dates do not automatically make maintained docs stale. Live fetch can be capacity-limited, and Extract can have per-URL failures with HTTP 200. These are directly relevant to a serious verifier. [S21, S22]

Omnidimension and Pathway are listed as community partners. Their presence does not require adding voice, streaming ETL, or local training to this project. This investigation concentrated on the hiring title partner and the secondary technology required by PS06; it did not comprehensively audit those two companies or all their staff.

## 6. Previous winners and current projects

### What could and could not be verified

The event is still accepting prototypes and has a future judging date. **No current winner can be established from this event’s schedule.** Searches found Hack-Nation Global AI Hackathon winner posts and Gloo AI Hackathon news, but those are different organizers/events. They were excluded as evidence of Geek Room judging preferences.

No independently verified historical winners list for this exact Geek Room/Bifrost series was found in the documented searches. That is an unresolved research limit, not evidence that this is the first edition or that no prior winners exist. The logged-in page exposes team management, not a public all-submissions gallery.

### Public entries that raise the bar

GitHub query **`"Global AI Hackathon" Bifrost in:readme`** returned **46 repositories** on November 10. They are matches to a public query, not 46 certified final submissions. Readme snapshots were opened for nine relevant projects; their code and benchmark claims were not independently executed.

| Project | What its inspected README demonstrates or claims | Implication for our choice |
|---|---|---|
| [Crucible](https://github.com/NitinSukthe-G/crucible) | Framework-neutral agent comparison, 10 chaos profiles, repeated runs, confidence intervals, CI gate, traces; reports 540 real runs | A basic chaos-benchmark dashboard has substantial overlap |
| [Assay](https://github.com/HeyJudo/Assay-research) | Frozen web, clean/poisoned pairs, claim-source judging, repeated research runs, agent design comparisons; marked active/planned | Frozen-web research plus evidence grading is already a well-articulated entry |
| [AgentBench Arena](https://github.com/Mohan-M04/agentbench-arena) | Fault injection, side-by-side traces, failure autopsy, counterfactual replays, Pareto views; reports simulated benchmarks separately | Even “what-if replay” alone is not a sufficient differentiator |
| [AgentPulse](https://github.com/UTSAVS26/AgentPulse) | Benchmarking + stale-answer verification, external model connectivity, traces/reports, explicit mock/live modes | Combining PS02 and PS06 alone is already taken |
| [Agent Gauntlet](https://github.com/ArjunAJ7/agent-gauntlet) | Deterministic graders, synthetic faults, Bifrost metrics, JSONL/static report; describes validated 112-run matrix | A simpler but measurable benchmark is a credible competitor |
| [FreshnessGuard AI](https://github.com/apoorv2202/freshnessguard-ai) | Claim verification, citations, native Go plugin, React UI, documented uncertain cases and live/offline provenance | Standalone “freshness firewall + Go plugin” is crowded too |
| [Bifrost Fresh Cache](https://github.com/MadhusudhanM23/bifrost-fresh-cache) | pgvector cache plus Tavily checks, adaptive checking/watchers, stated stale-serving tradeoffs | Do not choose the brief’s pgvector-cache example without checking existing work |
| [EPOCH AI](https://github.com/Devparth7-coder/EPOCH-AI) | Temporal evidence pipeline, contradiction handling, 114-claim deterministic evaluation, limitations | A big temporal dashboard is not a clear open gap |
| [TokenShield](https://github.com/Shristi1611/tokenshield) | Planned typed-fact quarantine, token-trap defenses, learned budgets; explicitly research prototype | Token safety also has thought-through competing proposals |

The complete query result is in [PROJECT_CATALOG.md](PROJECT_CATALOG.md). None is labeled a winner. “Reports” in this table means the author’s claim; reported counts are not accepted as validated measurements by this investigation. [S23]

### Closest external prior work

- **Bifrost’s own harness/mocker/chaosmock** is the most relevant prior work. RelayProof must be incremental and integrate cleanly.
- **Keploy** already records and replays API/dependency interactions as regression tests. Its official materials discuss noise handling, isolated dependencies, and CI. RelayProof does not invent record/replay; it specializes in multi-turn LLM protocol semantics, stream reconstruction, failure-preserving reduction, and current documentation evidence. [S24]
- **OpenAI and Anthropic official stream contracts** already define the semantics the oracle needs. OpenAI warns that interrupted streams may lack final usage; Anthropic says message-delta token counts are cumulative and tool input arrives as partial JSON. These support useful independent assertions. [S25, S26]

## 7. Option selection

These scores are **our planning judgments**, on a 1–5 scale, not organizer scores, empirical performance, or win probabilities.

Weights: exact challenge fit 25%; differentiation from inspected work 25%; demonstrability 20%; hiring relevance 20%; four-day delivery confidence 10%.

The same assessment is available as a [comparison chart](decision-comparison.html).

| Option | Fit | Differentiation | Demonstrability | Hiring relevance | Delivery | Weighted / 5 |
|---|---:|---:|---:|---:|---:|---:|
| **RelayProof: protocol reduction/export + API-advice audit** | 5 | 4 | 5 | 5 | 3 | **4.55** |
| Research-agent chaos/frozen-web lab | 5 | 2 | 4 | 4 | 4 | 3.75 |
| Token-efficient coding agent | 5 | 2 | 3 | 4 | 2 | 3.35 |
| Standalone stale-answer checker | 5 | 1 | 3 | 3 | 5 | 3.20 |

The first option is harder to build, especially the reducer. It earns the recommendation because the output—a small, reproducible, reviewable test—is more useful for the hiring company than another broad dashboard. Its differentiation remains a hypothesis to test, not a novelty claim.

If the integration spike cannot route the two client protocols through the pinned gateway by November 11 afternoon, narrow to the working OpenAI streaming/tool path and disclose it. Do not pivot to a completely new product late. If reduction cannot preserve the target by November 12 evening, keep a verified dependency-aware subset reducer before considering more protocols or AI-generated tests.

## 8. Why the project is technically substantial

The hard parts reinforce one another:

1. **Stateful protocol modeling:** tool calls, results, and next turns have dependencies that ordinary response diffing ignores.
2. **Streaming correctness:** event framing, partial JSON, Unicode boundaries, cumulative usage, and terminal state need real parsers.
3. **Independent oracles:** normalizations must tolerate generated noise without hiding identifier/usage defects.
4. **Failure reduction:** every simplification must remain a valid workflow and preserve the same assertion failure.
5. **Portable reproduction:** the exported test must run outside the application and sanitized workspace.
6. **Evidence discipline:** live documentation can disagree, disappear, or apply to a different version; the verifier must abstain.
7. **Reviewable developer experience:** a judge or maintainer must see what changed, why it matters, and how to reproduce it in minutes.

Adding more databases or autonomous agents would increase size without strengthening this loop. Add depth through protocol correctness, reduction quality, honest evaluation, and the maintainer-ready artifact.

## 9. What would falsify the recommendation

- The existing Bifrost harness already offers equivalent dependency-aware minimization and portable export in the exact needed workflow.
- A standard Bifrost install cannot support a controlled upstream or the selected client conversion without modifying its core.
- The reducer creates invalid cases or changes the failure signature most of the time.
- Maintainers cannot run the exported test without RelayProof’s internal code or paid services.
- The team cannot complete a working core slice before the deadline.

The implementation plan tests the second condition first, the third/fourth before UI polish, and preserves a small upstream-ready output even if the broader product remains a prototype.
