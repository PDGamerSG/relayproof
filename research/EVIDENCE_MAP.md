# Evidence map

Research snapshot: **10 November 2026**. Citations `[S01]`–`[S29]` refer to the groups below. A company's published product description is evidence of its stated offering; a repository README is evidence of an author's claims. Neither is an independently reproduced performance measurement. The recommendation, architecture, feature priorities, scores, and estimates are our proposals/inferences.

Local copies are indexed in [SOURCE_INDEX.md](SOURCE_INDEX.md). Some event pages require the user's authorized login. Keep the archive private; private dashboard material is not suitable for the public project repository. Search results were used for discovery, then material technical claims were checked against primary pages where accessible.

## Event and authorization

**[S01] Exact event, timeline, rules, and judging criteria — observed official page**

- URL: https://hackculture.io/hackathons/ai-global-hackathon
- Snapshot: [01-event-public.json](sources/01-event-public.json).
- Supports: Geek Room organizer; team size1–4; prototype phase November1–15,2026 ending11:59 PM displayed; judging November29,7–11:59 PM displayed; public GitHub repository, detailed README and pitch requirements; deployment optional.
- Supporting passages: “Your GitHub repository must be public”; “A deployed application is not mandatory”; schedule “15 Nov 2026, 11:59 PM”; criteria list innovation, technical execution, problem/potential impact, use of AI, UX, scalability/potential.
- Limits: browser rendering does not independently establish the schedule's timezone. Older rule “one final project” and a schedule exception for separate projects coexist. No numerical judging weights or named panel found.

**[S02] November7 announcement and workshop — observed official account dashboard**

- URL: https://hackculture.io/my-events/manage/6ad270bf8e6ece10acd71d71 (Announcements).
- Snapshot: [19-announcements.txt](sources/19-announcements.txt).
- Supports: Bifrost title partner; Tavily track partner; “Direct interview opportunities for winning teams”; $1,000 Bifrost cash prizes; one project, one per track, or an integrated project allowed in the latest specific announcement.
- November4 workshop post names Dhwanil Pithva as Founding Engineer and Swaponeel as GTM Engineer for November5.
- Limits: interview opportunity is not guaranteed employment. Earlier October31 wording required selecting both tracks; an integrated project is compatible with both versions. Tavily prize-credit wording differs between posts; do not infer a dollar valuation.

**[S03] All six mandatory challenge briefs — official PDFs**

| Problem | Original PDF | Local PDF / extracted text |
|---|---|---|
| PS01 token-efficient coding | [Official](https://hackcultureplatform.blob.core.windows.net/event-assets/hackathons/6ac5c8240037f69fb28e23ec/problem_explanation_q2jha91frd9.pdf) | [PDF](sources/theme-2.pdf), [text](sources/theme-2.txt) |
| PS02 agent benchmarking | [Official](https://hackcultureplatform.blob.core.windows.net/event-assets/hackathons/6ac5c8240037f69fb28e23ec/problem_explanation_ck1ellfr6qh.pdf) | [PDF](sources/theme-1.pdf), [text](sources/theme-1.txt) |
| PS03 authorized lab pentest | [Official](https://hackcultureplatform.blob.core.windows.net/event-assets/hackathons/6ac5c8240037f69fb28e23ec/problem_explanation_lawn3ha165.pdf) | [PDF](sources/theme-3.pdf), [text](sources/theme-3.txt) |
| PS04 Bifrost contributor | [Official](https://hackcultureplatform.blob.core.windows.net/event-assets/hackathons/6ac5c8240037f69fb28e23ec/problem_explanation_xssoky9neyn.pdf) | [PDF](sources/theme-4.pdf), [text](sources/theme-4.txt) |
| PS05 pre-meeting brief | [Official](https://hackcultureplatform.blob.core.windows.net/event-assets/hackathons/6ac5c8240037f69fb28e23ec/problem_explanation_a1nx56ua55u.pdf) | [PDF](sources/theme-5.pdf), [text](sources/theme-5.txt) |
| PS06 stale-answer detector | [Official](https://hackcultureplatform.blob.core.windows.net/event-assets/hackathons/6ac5c8240037f69fb28e23ec/problem_explanation_urf74r9ydml.pdf) | [PDF](sources/theme-6.pdf), [text](sources/theme-6.txt) |

- PS04 explicitly permits a developer tool or gateway migration utility, supported interfaces, standard install, tests/docs, potential upstream contribution. It says to check existing functionality before choosing.
- PS06 requires an LLM answer, sensitive-claim identification, live re-verification, per-claim freshness score, and meaningful integration of both Tavily and Bifrost.
- Limits: these are challenge requirements, not evidence that RelayProof is implemented or that an organizer has approved the proposed architecture. `theme-1` is PS02, not PS01.

**[S04] Submission-management limit — observed authorized UI**

- URL: account page above, team/submissions sections.
- Snapshot: [03-submission-access.txt](sources/03-submission-access.txt); [02-account-initial.json](sources/02-account-initial.json) is an initial/incomplete loading snapshot and must not be used to infer absence of submissions.
- Passage: “Team Leader Access”; “Only your team leader can create and manage submissions for this phase. You will be able to view once submitted.”
- Supports: member account cannot manage this phase; team `vulcan`, leader displayed Hydra Of Malice; no project deleted and no existing submission title verified.
- Limits: an invisible submission is not proof that none exists. Do not bypass access or change membership.

## Bifrost and Maxim products / engineering

**[S05] Public Bifrost repository and company offering — first-party documentation**

- URLs: https://github.com/maximhq/bifrost ; https://www.getmaxim.ai/
- Snapshots: [repository](sources/05-bifrost-github.json), [home](sources/06-company-home.json), [about](sources/13-maxim-about.json).
- Supports: Go gateway, multi-provider routing, governance/caching/observability, open-source ecosystem. Maxim positions gateway/governance, observability, and evaluation as its stack.
- Limits: headline overhead/throughput/customer figures are publisher claims, not reproduced measurements. Do not copy conflicting marketing latency numbers into our results.

**[S06] Retries, telemetry, and compatibility — official technical docs**

- URLs: https://docs.getbifrost.ai/features/retries-and-fallbacks ; https://docs.getbifrost.ai/features/telemetry ; https://docs.getbifrost.ai/features/compat-plugin
- Snapshots: [16](sources/16-bifrost-retries.json), [17](sources/17-bifrost-telemetry.json), [22](sources/22-bifrost-compat.json).
- Supports: retry/fallback logic, metrics/OTel, supported compatibility behavior already exist; RelayProof should isolate retry semantics and declared conversion capabilities.
- Limits: documentation is not proof every protocol mapping is lossless. Verify the selected pinned runtime routes during implementation.

**[S07] Agent Gateway — official dated launch article**

- URL: https://www.getmaxim.ai/bifrost/blog/introducing-agent-gateway-in-bifrost-one-gateway-for-models-tools-and-agents
- Snapshot: [32-agent-gateway-announcement.json](sources/32-agent-gateway-announcement.json).
- Author/date: Dhwanil Pithva, October20,2026.
- Supports: A2A gateway, agent/model/tool correlation, access controls, logs, transport bridging; article names `x-bf-session-id` and `x-bf-agent-correlation-id`.
- Inference: more agent handoffs make state-preserving compatibility artifacts useful. RelayProof does not implement general A2A conformance in P0.

**[S08] Bifrost Edge — official product page**

- URL: https://www.getmaxim.ai/edge
- Snapshot: [15-bifrost-edge.json](sources/15-bifrost-edge.json).
- Passage: covers “desktop apps, browser AI, coding tools” and passes intercepted requests through Bifrost governance.
- Supports: endpoint AI governance is already a public product direction; avoid presenting a desktop shadow-AI proxy as an unoccupied sponsor gap.
- Limits: no internal launch roadmap, deployment evaluation, or feature-completeness audit performed.

**[S09] Maxim agent simulation/evaluation — official product page**

- URL: https://www.getmaxim.ai/evals/products/agent-simulation-evaluation
- Snapshot: [14-maxim-agent-evaluation.json](sources/14-maxim-agent-evaluation.json).
- Supports: simulation, datasets, agent evaluation, dashboards, SDK/CI integration and enterprise-facing deployment already appear in the offering.
- Inference: a generic benchmark dashboard overlaps. This does not mean no third-party benchmark can be valuable.

**[S10] HTTP transport v2.5.1 — official release record**

- URL: https://github.com/maximhq/bifrost/releases/tag/transports/v2.5.1
- Snapshot: [07-bifrost-latest-release.json](sources/07-bifrost-latest-release.json), API HTTP200, retrieved14:40 UTC.
- Published: November10,2026,08:07:52 UTC. Installation image: `maximhq/bifrost:v2.5.1`; native command: `npx @maximhq/bifrost --transport-version v2.5.1`.
- Supports: missing/empty chat messages return400; null Gemini entries skipped; provider/converter/plugin stream panics get terminal error/logging/billing recovery. Separate corev1.15.2/frameworkv1.12.2.
- Limits: latest at retrieval time; no image digest downloaded, image launch, or release performance test during research.

**[S11] Recent repository commits — observable merged activity**

- Snapshot: [08-bifrost-recent-commits.json](sources/08-bifrost-recent-commits.json), most recent12 API entries, not a full history.
- [#9807 Vertex serialization](https://github.com/maximhq/bifrost/commit/fdb3cbad1afd59ed87c7961cc5f66b1e5feab42e): ordering tools/system before growing messages for prompt-cache behavior.
- [#9733 MCP/roleless conversion](https://github.com/maximhq/bifrost/commit/65e418a2e66168d2e7b43bfddc6e02ffefc4954e): drop unsupported roleless Responses items on Chat fallback; closes#9721.
- [#9238 cancelled usage](https://github.com/maximhq/bifrost/commit/aa3b279eac27e33ef069f7e563532dce7f854ff4): tokenizer estimates on cancelled/timed-out streams and estimation provenance.
- [#9805 UI asset failures](https://github.com/maximhq/bifrost/commit/354472245f1699ce430d2d9d11fbcadd50396a9e): distinguish confirmed upgrade404 from proxy/network blocking.
- Supports: current correctness/streaming/provenance/DX work. Limits: authorship is observable contribution, not a complete account of internal responsibilities; merged on the inspected branch does not guarantee inclusion in every release.

**[S12] Open pull requests — proposals/in-progress contributions**

- URL: https://github.com/maximhq/bifrost/pulls
- Snapshot: [09-bifrost-open-prs.json](sources/09-bifrost-open-prs.json), latest20 updated open PRs at retrieval.
- Supports: router/complexity/phrase rules, governance reconciliation, provider and integration proposals; individual names are mapped only where public profiles support them.
- Limits: open state and proposal text do not establish shipping schedule, endorsement, final design, or employment.

**[S13] Existing provider harness — official coverage docs**

- URL: https://docs.getbifrost.ai/providers/test-harness-coverage
- Snapshot: [21-bifrost-test-harness.json](sources/21-bifrost-test-harness.json).
- Passage: “Total:725 requests across12 folders”; viewer has “Resend + Copy curl”; matrices/failure reports/live calls described.
- Supports: substantial existing test/report infrastructure. Limits: count is the docs' claim; harness was not executed or audited for completeness.

**[S14] Existing MCP chaos infrastructure — repository PR discovery/results**

- Snapshot: [issues-chaos.json](sources/issues-chaos.json), query `repo:maximhq/bifrost chaos`,49 matches at retrieval, first10 returned.
- Examples: [#9082](https://github.com/maximhq/bifrost/pull/9082), [#9083](https://github.com/maximhq/bifrost/pull/9083), [#9087](https://github.com/maximhq/bifrost/pull/9087), [#9482](https://github.com/maximhq/bifrost/pull/9482).
- Supports: controllable mock fleet, legacy HTTP/SSE/STDIO bridge, harness failure/tool/session testing already under development/present in public contributions.
- Limits: API search snippets/PR bodies were inspected, not all patches executed. Do not conflate the MCP harness with the proposed full protocol reducer/export UX.

**[S15] Native plugin compatibility — official plugin guide**

- URL: https://docs.getbifrost.ai/plugins/writing-go-plugin
- Snapshot: [18-bifrost-custom-plugins.json](sources/18-bifrost-custom-plugins.json), original requested path redirected to this guide.
- Supports: compiler/core/module dependency and OS/architecture coupling; release transport/core versions tagged separately; rebuild on relevant upgrades.
- Inference: use supported provider configuration and HTTP as lower-risk P0 integration. The choice is architectural judgment, not a ban on plugins.

## Public professional work and hiring fit

**[S16] Public profiles — self-reported professional relationships**

| Profile | Local copy | Verified displayed text |
|---|---|---|
| [akshaydeo](https://github.com/akshaydeo) | [JSON](sources/profile-akshaydeo.json) | Akshay Deo, cofounder/CTO, `@maximhq` |
| [Pratham-Mishra04](https://github.com/Pratham-Mishra04) | [JSON](sources/profile-Pratham-Mishra04.json) | Pratham Mishra, founding engineer at Maxim AI |
| [impoiler](https://github.com/impoiler) | [JSON](sources/profile-impoiler.json) | Suresh Chaudhary, founding engineer, building Bifrost |
| [TejasGhatte](https://github.com/TejasGhatte) | [JSON](sources/profile-TejasGhatte.json) | Tejas Ghatte, company `@maximhq` |
| [BearTS](https://github.com/BearTS) | [JSON](sources/profile-BearTS.json) | Anuj Parihar, Bifrost maintainer/backend; no company in profile |
| [kohlivrinda](https://github.com/kohlivrinda) | [JSON](sources/profile-kohlivrinda.json) | Name `vrivri`, `@maximhq`, MLE bio; full name not verified |

Limit: public profiles can change; contributors are not automatically employees. No private contact details, inferred identities, or sensitive personal profiling is needed for this project.

**[S17] Pratham/Dhwanil authored work — public activity and official announcement**

- [Pratham commit view](https://github.com/maximhq/bifrost/commits/dev/?author=Pratham-Mishra04), [snapshot](sources/41-pratham-commits-public.json): November2–7 MCP auth/discovery/isolation tests, chaosmock bridge, log UX, bounded parsing.
- [Dhwanil profile](https://github.com/danpiths), [snapshot](sources/40-dhwanil-profile-public.json): public README explicitly “aka dhwanil pithva,” full-stack work; official article[S07] establishes authorship; workshop[S02] supplies role.
- Limits: API attempts for these pages were403; browser fallback succeeded. Do not turn a README's aspirations into evidence of a specific shipped company feature.

**[S18] MTS job description — official hiring priorities**

- URL: https://www.getmaxim.ai/careers/member-of-technical-staff
- Snapshot: [12-maxim-mts-role.json](sources/12-maxim-mts-role.json), [careers](sources/11-maxim-careers.json).
- Passages: “Primary:Go”; “Secondary:Typescript + NextJS”; maintain OSS, clear documentation/onboarding, enterprise features, external developer tools, databases, thoughtful engineering/UX. Role lists2–4 years and Bangalore.
- Inference: Go + Next.js and a reviewable maintainer artifact are strong hiring signals. This does not establish how hackathon judges score projects or waive job eligibility.

## Tavily direction and exact API behavior

**[S19] October2026 product update — official dated article**

- URL: https://www.tavily.com/blog/what-shipped-october-2026
- Snapshot: [36-tavily-october.json](sources/36-tavily-october.json).
- Author/date: Stefanie Miller, November2,2026. Supports fetch-age controls0–720h, EU processing/retention evaluation, integrations, Company Search Benchmark, DevRel Ricky Johnson's practical tooling sessions.
- Limits: benchmark rankings/customer results are publisher claims, not rerun here. Author/DevRel work is public communication, not a complete engineering assignment map.

**[S20] Nebius/Tavily integration — official acquisition article**

- URL: https://nebius.com/blog/posts/bringing-agentic-search-into-the-production-ai-stack
- Snapshot: [37-tavily-nebius.json](sources/37-tavily-nebius.json), dated May20,2026.
- Passage: “Nebius has acquired Tavily”; Token Factory inference + Tavily current web retrieval. Authors named Jakki Jakaj and Dylan Bristot on the page.
- Limits: describes public platform direction; no claim that Nebius is the hiring title partner in this event.

**[S21] Tavily Search — official API reference**

- URL: https://docs.tavily.com/documentation/api-reference/endpoint/search
- Snapshot: [24-tavily-search.json](sources/24-tavily-search.json).
- Supports: basic search1 credit; max results/domains/usage options; auto-parameter behavior; `max_age_hours` fetch freshness versus publication-date filters, capacity/fetch limits.
- Design implication: bound calls and domains, request fresh retrieval, do not discard maintained docs because of an old publish date.
- Limits: docs can evolve; actual request/usage must be verified at build time.0-hour request does not guarantee every source is freshly available.

**[S22] Tavily Extract — official API reference**

- URL: https://docs.tavily.com/documentation/api-reference/endpoint/extract
- Snapshot: [25-tavily-extract.json](sources/25-tavily-extract.json).
- Passage: “Check both arrays even when the response is HTTP200.” Basic extraction1 credit per5 successful URLs; advanced2 per5.
- Supports: successful `results` and `failed_results`, exact fetched content, timeouts/options, extraction billing basis.
- Limits: no `max_age_hours` field was found in the inspected Extract schema; do not add it blindly. Billing estimates depend on batching/retries and returned usage.

## Competitors, prior work, and oracle contracts

**[S23] Public candidate projects — repository search and author READMEs**

- Query: `"Global AI Hackathon" Bifrost in:readme`; [API search](https://api.github.com/search/repositories?q=%22Global%20AI%20Hackathon%22%20Bifrost%20in%3Areadme&sort=updated&per_page=100).
- Snapshot: [repo-search-full.json](sources/repo-search-full.json), November10,14:45 UTC;46 results, `incomplete_results:false`, all46 items retrieved.
- Nine README snapshots + metadata with Git blob SHA: see [PROJECT_CATALOG.md](PROJECT_CATALOG.md).
- Supports: substantial public overlap in agent benchmarking, replay, evidence grading, freshness checking, caching, and token defense proposals.
- Limits: matches are not certified submissions or winners. README-run counts are self-reports. Code/deployment/benchmarks not executed. Search can miss private/unindexed/differently named entries.

**[S24] Keploy — existing API record/replay work**

- URL: https://keploy.io/record-replay-testing
- Snapshot: [35-Keploy.json](sources/35-Keploy.json).
- Supports: established API/dependency recording, isolated replay and CI regression testing. Limits: no head-to-head product benchmark or complete competitor survey performed. RelayProof's intended specialization is protocol semantics plus valid reduction/export and documentary evidence.

**[S25] OpenAI streaming semantics — official reference**

- URL: https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events
- Snapshot: [33-OpenAI-streaming.json](sources/33-OpenAI-streaming.json).
- Passages: final chunk may have empty choices when usage requested; interrupted/cancelled streams may lack final usage.
- Supports: independent assertions about known/unknown usage and terminal chunks. Limits: an SDK example for one route does not prove universal provider compatibility.

**[S26] Anthropic streaming semantics — official reference**

- URL: https://platform.claude.com/docs/en/build-with-claude/streaming
- Snapshot: [34-Claude-streaming.json](sources/34-Claude-streaming.json).
- Passages: message-delta usage counts “are cumulative”; tool input uses partial JSON; ping/unknown events and stream error events can occur.
- Supports: latest-authoritative-field policy, partial-JSON reconstruction, correct terminal error handling. Limits: claims about reverse conversion require actual Bifrost tests.

**[S27] Supported custom-provider integration — official docs**

- URL: https://docs.getbifrost.ai/providers/custom-providers
- Snapshot: [23-bifrost-custom-provider.json](sources/23-bifrost-custom-provider.json).
- Supports: custom provider alias/base provider, network configuration, allowed request types. Limits: the complete proposed compose/config was not launched; Task1 must validate release-specific shape, routing paths, and private-network settings.

**[S28] Historical/current issue examples — issue reports, not reproduced findings**

- [#9721](https://github.com/maximhq/bifrost/issues/9721), [snapshot](sources/39-issue-mcp-role-public.json): roleless MCP history conversion; closed via#9733.
- [#8983](https://github.com/maximhq/bifrost/issues/8983), [snapshot](sources/38-issue-stream-usage-public.json): stream span tokens when logging disabled; open at inspection.
- Limits: reports are leads. No affected/fixed version pair reproduced here; neither is a RelayProof discovery. API retrieval failed403; public UI fallback succeeded.

**[S29] Local prerequisites — direct read-only observations**

- Snapshot: [42-local-environment.json](sources/42-local-environment.json).
- Supports: ARM64,64 GiB/10 logical CPUs observed; installed Go1.27.3, Node26.8.1, pnpm10.18.0; Docker client29.8.1 with unavailable daemon/socket.
- Limits: no container launch, model throughput test, or end-to-end runtime validation. Proposed Node22 pin requires selecting the build toolchain. RAM alone does not establish inference speed.

## What remains inference or unverified

- **Selection:** RelayProof is the strongest option under the stated planning rubric and inspected competitors, not an objectively proven best project or winning probability.
- **Gap:** no equivalent full minimization/export workflow was established in the inspected materials. Search absence is not proof of novelty; existing conformance PR#4384 is relevant prior art and its full patch was not retrieved after rate limiting.
- **Company fit:** public hiring/product/activity evidence supports the direction. No private roadmap or judging preferences are known.
- **Historical winners:** none for this exact event/series was independently verified; similar Hack-Nation/Gloo events are excluded. See exact queries in[SEARCH_LOG.md](SEARCH_LOG.md).
- **Implementation:** feature scope, version/config proposal, algorithm, cost allowance, delivery estimate, and evaluation targets are plans. Actual operation and measurements must be established by the build.
