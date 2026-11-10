# Assay

**Know which research agent to trust, and why.**

Assay is a benchmarking platform for AI research agents. It runs several agents on the same tasks, against the same frozen copy of the web, with planted traps, three times each. Then it checks every claim against its cited source and ranks the agents by what matters to you: accuracy, reliability, cost, trap resistance and honesty.

> **Status:** in active development for the [Global AI Hackathon 2026](https://hackculture.io/hackathons/ai-global-hackathon) (build window Nov 1–15). Spec is final. Code lands from Nov 9. Sections marked _(planned)_ describe the target and will be replaced with real instructions as each part ships.

| Track | Problem statement | How Assay answers it |
|---|---|---|
| **Primary: Bifrost** | PS02: benchmarking platform for agents, research category | Framework-independent runs, repeated 3×, controlled failures, step-by-step run receipts, comparison UI |
| **Integration: Tavily** | PS05: pre-meeting briefing agent | Our Briefing Agent, built in 3 versions and tested on Assay. Tavily also builds the frozen web |

## The problem

- **Research-agent scores can't be repeated.** The live web changes daily, so two agents tested on different days aren't comparable.
- **One good run hides flakiness.** Single-run scores overstate reliability by 20–40% (ReliabilityBench, 2026).
- **Reports sound right but cite badly.** Nobody checks whether each source says what the agent claims.
- **Agents believe fake sources.** One planted article collapsed accuracy in six frontier models (arXiv 2603.00801).
- **Agents guess instead of saying "I don't know."** Most benchmarks reward guessing.
- **Leaderboards say who won, not why.** Outside agents differ in model, prompt and search all at once.

Full evidence and sources: [`docs/PRD.md`](docs/PRD.md#why-it-matters-evidence-for-the-deck).

## What Assay does

- **Frozen web.** Each task gets a fixed pool of real documents, collected once with Tavily. Every agent searches and reads only that pool, so runs are repeatable.
- **Plug in any agent with env vars only.** Its model calls go through Bifrost and its web traffic through the Assay search proxy. No code changes to the agent.
- **Traps.** Fake article, hidden instruction, search outage, model outage. Planted identically for every agent, each with a clean twin as the baseline.
- **Claim-by-claim citation check.** A judge from a different model family marks every claim supported, unsupported, trap or not found, with the exact source quote.
- **Reliability, cost and honesty.** Every task runs 3×. We report pass^3, cost per correct answer, and whether agents say "Not found" when the answer truly isn't there.
- **Explains why.** Our Briefing Agent comes in three versions that differ in one design choice each (Baseline, Cheap-first, Evidence-gated). Assay measures what each choice changes.

## Screens

| Screen | What you do there |
|---|---|
| **Home** | See the headline findings and the top agents |
| **Leaderboard** | Drag "what matters to you" sliders and get the best-fit agent |
| **Run** | Pick up to 3 agents, a task and a trap, press Run, watch it live |
| **Compare** | Head-to-head of two agents, with spread across runs |
| **Run receipt** | Every step, cost by model, and every claim with its source |
| **Briefing Agent** | Company + meeting time in, one-page sourced brief out (PS05) |

## How it works

```
React app ──HTTP/SSE──► FastAPI ──► SQLite
                           │
                        Runner ── starts each agent with env vars
                    ┌──────┴───────┐
                    ▼              ▼
             Bifrost gateway   Search proxy (mitmproxy)
             all LLM calls,    serves the frozen pool,
             cost, budgets,    injects traps,
             fallbacks         logs every search
```

A run's step-by-step trace is built from the two places every research agent must pass through: Bifrost (model calls) and the search proxy (web access). That is what makes Assay framework-independent.

## How we use the sponsors

- **Bifrost:** gateway for every model call from every agent and the judge. Token and cost logs per model, virtual keys with budgets, load balancing across free-tier keys, provider fallback, and simulated model outages for failure tests.
- **Tavily:** builds every frozen document pool (search + extract). Powers the live Briefing Agent. The proxy speaks Tavily's API format, so agents written for Tavily run on Assay unchanged.

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python 3.12, FastAPI, uv, SQLite |
| Search proxy | mitmproxy add-on |
| Gateway | Bifrost (Docker / npx) |
| Frontend | React, Vite, TypeScript, Tailwind CSS, shadcn/ui, Recharts |
| Live updates | Server-Sent Events |
| Models | Open models (Llama family) on free tiers for agents. An OpenAI GPT model as the judge |
| Deploy | One Docker image (Hugging Face Space) |

## Getting started

Prerequisites: Docker Desktop (full stack), or Node 20.19+ + Python 3.12 + [uv](https://docs.astral.sh/uv/) to run parts separately. API keys: Tavily, OpenAI (judge), and at least one free provider (Groq, OpenRouter, Gemini or Cerebras).

The API currently serves fake run records from `web/src/fixtures/`. The runner, SQLite and live endpoints come next.

**Full stack** (app + API at http://localhost:8000, Bifrost UI at http://localhost:8080). The Bifrost dashboard asks for `BIFROST_SETUP_TOKEN` (any secret you put in `.env`) once, to create the admin account:

```bash
git clone https://github.com/HeyJudo/Assay-research.git
cd Assay-research
cp .env.example .env    # add your keys
docker compose up --build
```

**Frontend only** (Node, no Python; reads the fixtures directly, http://localhost:5173):

```bash
cd web
npm install
npm run dev
```

**Backend only** (API at http://localhost:8000/api/runs, docs at `/docs`):

```bash
cd backend
uv run uvicorn assay.api:app --reload
```

Set `ASSAY_SEED_FIXTURES=1` to load the fixture runs into an empty DB for frontend work.

**Bifrost alone** (UI at http://localhost:8080, reads `bifrost/config.json`; export the keys from `.env` first):

```bash
npx -y @maximhq/bifrost -app-dir ./bifrost
```

## Repository layout

```
backend/assay/      FastAPI app (api.py) and the run record (models.py)
web/src/            React app: pages/, types.ts (mirrors models.py), fixtures/ (fake data, shared with the API)
bifrost/            Bifrost config.json
docs/               PRD and hackathon context
Dockerfile          one image: builds web/, FastAPI serves it + the API on port 8000
docker-compose.yml  app + Bifrost
```

## Methodology

Same pools, tasks and trap seeds for every agent. Answers verified in-pool by two people. pass^3 and spread reported, not just averages. Judge validated against 50 hand-labeled claims. Our agents are tuned only on separate practice tasks, and at least one outside agent is always on the board. Results that make our own agents look bad get published too. Full rules: [`docs/PRD.md`](docs/PRD.md) §9.

## Team

| Role | Owns |
|---|---|
| Lead (Jude) | Platform: search proxy, pools, traps, runner, API, Bifrost, deploy |
| Backend | Briefing Agent (3 versions) and graders |
| Frontend | Dashboard screens |

## AI tool disclosure

We build with AI-assisted development. Claude Code (Anthropic) helped with planning, the spec, documentation and code. Every change is reviewed and merged by a team member. Assay itself calls LLMs at runtime: open models as the agents under test and an OpenAI model as the judge, all through Bifrost.

## Docs

- [`docs/PRD.md`](docs/PRD.md): full spec, data contracts, roles and schedule
- [`docs/HACKATHON_CONTEXT.md`](docs/HACKATHON_CONTEXT.md): rules, judging criteria, submission checklist

## License

[MIT](LICENSE)
