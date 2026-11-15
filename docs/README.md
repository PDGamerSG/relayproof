# Documentation

Where to find each part of the RelayProof documentation. Everything here describes the repository as it is. Statements cite the file they come from, and anything the repository does not record is marked "Not recorded in the repository".

## Start here

| Document | What it covers |
| --- | --- |
| [README](../README.md) | What RelayProof is, the team, the live link, how it works and the quick start |
| [User guide](user-guide.md) | The landing page, each tab of the live console, and the dashboard page |
| [Troubleshooting](TROUBLESHOOTING.md) | Build, demo and console problems and their fixes |

## Suggested reading order

1. [README](../README.md): what RelayProof does and the "How it works" diagram.
2. [User guide](user-guide.md): try the live console tab by tab.
3. [Architecture](ARCHITECTURE.md): how the parts connect and what is not built yet.
4. [Configuration](CONFIGURATION.md): the settings each part reads.
5. [Plugin internals](../bifrost-shadow/ARCHITECTURE.md): the plugin's live-path guarantees and data flow in depth.

## Reference

| Document | What it covers |
| --- | --- |
| [Architecture](ARCHITECTURE.md) | The parts, outside services, the main request, the stored data and the deployment |
| [Configuration](CONFIGURATION.md) | The plugin's settings and every environment variable the demo, the hosted backend and the site read |
| [HTTP API](api/README.md) | The `/api/shadow/*` and `/api/demo/*` routes |
| [Deployment](operations/deployment.md) | Vercel, Render, spend caps, logs and checks |
| [Threat model](security/threat-model.md) | What the hosted demo receives and sends, and how keys are kept |
| [Test plan](testing/test-plan.md) | What is tested, how to run it and what CI runs |
| [Glossary](glossary.md) | Terms used in the code and the docs |

## Project documents in `bifrost-shadow/`

| Document | What it covers |
| --- | --- |
| [Project README](../bifrost-shadow/README.md) | The plugin's features, the demo results, the dashboard page, overhead benchmarks and limitations |
| [Plugin architecture](../bifrost-shadow/ARCHITECTURE.md) | Live-path guarantees, the data flow step by step, readiness maths, promotion and the canary guard |
| [Verification](../bifrost-shadow/TESTING.md) | How each guarantee was tested and measured |
| [Frontend contract](../bifrost-shadow/api/README.md) | Auth, CORS, the OpenAPI spec and the typed TypeScript client |
| [Site README](../bifrost-shadow/site/README.md) | The landing page, the console's tabs, and where the site's numbers come from |
| [Feature reference](../bifrost-shadow/docs/features/shadow-traffic.mdx) | The plugin's full configuration reference, written for the Bifrost docs |
| [Upstream PR draft](../bifrost-shadow/UPSTREAM_PR.md) | The pull request text for contributing the plugin upstream |
| [Submission draft](../bifrost-shadow/SUBMISSION.md) | A draft of the hackathon submission text |

## Archive

These files describe an earlier plan that was researched on 10 November 2026 and not built. They are kept as a record. [The research archive README](../research/README.md) explains them.

| Document | What it covers |
| --- | --- |
| [Technical design](TECHNICAL_DESIGN.md) | The earlier plan's architecture |
| [Evaluation and demo](EVALUATION_AND_DEMO.md) | The earlier plan's scenarios and demo script |
| [Submission draft](SUBMISSION_DRAFT.md) | The earlier plan's submission copy |
| [Product specification](superpowers/specs/2026-11-10-relayproof-design.md) | The earlier plan's product spec |
| [Implementation plan](superpowers/plans/2026-11-10-relayproof.md) | The earlier plan's task list |
