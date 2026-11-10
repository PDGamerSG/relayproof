# EPOCH AI — Temporal Intelligence & Evidence Verification Engine

> **Information has a lifespan. EPOCH measures it.**

EPOCH AI is an evidence-driven verification platform. It takes a claim block, an AI-generated answer or a
document, decomposes it into atomic claims, retrieves **current** evidence, separates *publication time* from
*validity time*, detects contradictions, and issues one of six explainable verdicts — or refuses to decide.

It is not a chatbot and not a retrieval demo. It is a six-stage verification pipeline with a persisted,
replayable evidence trail behind every verdict.

---

## 1. What actually runs

| Layer | Implementation |
|---|---|
| Frontend | React 18 · Vite 6 · TypeScript · Tailwind CSS · Framer Motion · Recharts · Lucide · React Router |
| Backend | Python 3.11+ · FastAPI · Pydantic v2 · SQLAlchemy 2.0 |
| Database | SQLite (zero-config default) or PostgreSQL 16 · optional **pgvector** ANN index |
| Models | **Bifrost by Maxim AI** gateway → OpenAI → Gemini → deterministic engine fallback |
| Research | **Tavily** live web search → bundled evidence corpus (deterministic, offline) |
| Deploy | Single Docker image (API + built SPA) · Render blueprint · Vercel config · docker-compose with pgvector |

Two runtime modes, both honest:

- **live** — `TAVILY_API_KEY` + a model key are configured. Real searches, real model calls, real costs.
- **simulated** — no external credentials. The deterministic engines and the bundled corpus run instead, so
  every test, benchmark run and UI number is still a *real measurement* of that mode. The UI labels it
  everywhere (`ModeBadge`, health endpoint, observability page). Nothing is dressed up as live.

---

## 2. Quickstart (2 minutes, no keys required)

```bash
git clone <your-repo> epoch-ai && cd epoch-ai

# backend
cd backend
pip install -r requirements.txt          # FastAPI, SQLAlchemy, httpx, pytest…
python -m pytest tests -q                # 22 tests
python -m uvicorn app.main:app --port 8000

# frontend (second terminal, optional — the API also serves a prebuilt SPA)
cd frontend
npm install
npm run dev                              # http://localhost:5173 (proxies /api)
```

Open <http://localhost:8000> (if `frontend/dist` exists) or <http://localhost:5173>, then
**Research workspace → paste → Run verification**.

If a sandbox/session restart wiped installed packages or `frontend/dist` (only source files persist), repair
and relaunch everything with one command:

```bash
./scripts/resume_preview.sh          # install what's missing, rebuild the SPA, run tests, serve on :8000
./scripts/resume_preview.sh --check  # same repairs, verify only, don't serve
./scripts/resume_preview.sh --force  # reinstall and rebuild from scratch
```

Produce the benchmark artefact the UI reads:

```bash
cd backend
python benchmark/build_dataset.py         # writes 114 labelled claims
python benchmark/run_benchmark.py --persist --fit-calibration
```

Enable live mode: copy `.env.example` → `backend/.env`, set `TAVILY_API_KEY` and one of
`BIFROST_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`, restart. Health will report `live`.

---

## 3. The pipeline

Six stages, each persisted with its own timings and metrics before the next begins, so the workspace renders
real execution state instead of an animation.

| # | Stage | Module | What it does |
|---|---|---|---|
| 1 | Extract claims | `app/services/research/claim_extraction.py` | Atomic claims + entities, dates, numbers, versions, checkworthiness |
| 2 | Plan research | `app/services/research/planner.py` | Non-redundant, claim-type-aware search queries |
| 3 | Retrieve evidence | `app/services/research/retrieval.py` | Tavily / corpus / fixtures → normalise, dedupe, timestamp, score authority |
| 4 | Analyse temporally | `app/services/research/temporal.py` | Publication vs effective dates, decay, supersession, version drift, expiry |
| 5 | Detect contradictions | `app/services/research/contradiction.py` | Stance per claim–source pair; polarity, version, numeric, supersession, scope |
| 6 | Decide & explain | `app/services/research/verdict.py` + `scoring.py` | Six verdicts, evidence quality, calibrated probability, written rationale |

**Verdicts:** `VERIFIED` · `PARTIALLY_OUTDATED` · `OUTDATED` · `CONTRADICTED` · `UNVERIFIED` · `CONFLICTING`.

Hard rules enforced in code, not in prose:

- `VERIFIED` requires sufficient support **and** independent corroboration or a high-authority primary source.
- `UNVERIFIED` is a first-class outcome and its calibrated confidence is capped below 0.5 — a refusal is not a finding.
- Disagreement is only reported as `CONFLICTING` when recency *cannot* resolve it; otherwise the temporal layer
  resolves it into `OUTDATED`.
- Evidence quality (a measurement) and calibrated probability (a prediction) are computed separately and never
  conflated in the UI.

---

## 4. Pages

| Route | Page | Purpose |
|---|---|---|
| `/` | Landing | Hero, pipeline explanation, live capability state, **real** benchmark results, real example verdicts |
| `/app` | Intelligence dashboard | Claims analysed, outdated detected, evidence quality, verdict distribution, activity, history, system status |
| `/app/workspace` | Research workspace | Claim block / AI answer / URL input, depth selector, live execution states, per-claim verdicts |
| `/app/evidence/:id` | Evidence explorer | Interactive claim–source–temporal graph, node inspector, source table, temporal observations |
| `/app/research/:id` | Verification report | Overall + per-claim verdicts, evidence, dates, version comparisons, limitations, export (JSON/Markdown/print) |
| `/app/history` | Research history | Search, verdict/status/date filters, pagination, verdict distribution |
| `/app/system` | Observability | Gateway + routing, tokens, latency by stage, searches, failures, estimated cost, benchmark run |

Dark and light themes, keyboard-focus states, loading skeletons, and real empty states throughout.

---

## 5. API (v1)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/claims/preview` | Extract claims without running research (fast, no persistence) |
| POST | `/api/v1/research` | Create an investigation (`run_synchronously` for tests/CLI) |
| GET | `/api/v1/research/{id}` | Session state, real stage states, claims + verdicts |
| GET | `/api/v1/research/{id}/evidence` | Evidence bundle + graph (nodes/links/counts) |
| GET | `/api/v1/research/{id}/report` | Full report incl. calibration note and limitations |
| GET | `/api/v1/history` | Paginated, filterable investigations |
| GET | `/api/v1/analytics` | Dashboard aggregates |
| GET | `/api/v1/system/health` | Mode, providers, routing, DB, limits |
| GET | `/api/v1/system/observability` | Calls by model/route, tokens, latency, failures, cost |
| GET | `/api/v1/benchmark/latest` | Latest measured benchmark artefact + real examples |

Interactive OpenAPI docs: `/api/docs`. Errors are uniform:
`{"error": {"code", "message", "details", "request_id"}}`.

---

## 6. Measured results

From `backend/benchmark/results/latest.json` — 114 labelled claims, deterministic retrieval, six verdict classes:

| Metric | EPOCH pipeline | LLM-only baseline |
|---|---|---|
| Verdict accuracy | **82.5%** | 32.5% |
| Macro F1 | **0.824** | 0.174 |
| Macro precision / recall | **0.854 / 0.818** | 0.123 / 0.325 |
| Outdated detection recall | **87.1%** | 0.0% |
| Citation correctness | **100%** | 0.0% |
| False verification rate ↓ | **18.2%** | 76.3% |
| Mean latency | 12.5 ms (deterministic mode) | — |
| Cost / investigation | $0.00 (deterministic mode) | — |

Per class (F1): VERIFIED 0.88 · PARTIALLY_OUTDATED 0.80 · OUTDATED 0.73 · CONTRADICTED 0.80 · UNVERIFIED 0.88 ·
CONFLICTING 0.85. Calibration: Platt-style fit, Brier **0.142** (*in-sample*, see limitations).

These are measured values of the current build. They are not targets, and no target is displayed as a result.
Full methodology, confusion matrix and honest failure analysis: [`docs/BENCHMARK.md`](docs/BENCHMARK.md).

---

## 7. Security & reliability

- **Secrets stay server-side.** The frontend only ever calls same-origin `/api` routes; no key is shipped to the browser.
- **SSRF protection** (`app/core/security.py`): scheme allow-list, credential rejection, DNS resolution checked
  against private/loopback/link-local/reserved ranges before any fetch.
- **Untrusted content fencing.** Retrieved pages are wrapped in `<<<UNTRUSTED_DATA>>>` blocks and never placed in a
  system prompt; injection signatures are detected and stored per source (`injection_flags`) and surfaced in the UI.
- **Input sanitisation & limits.** Control-character stripping, 20k character cap, 4× body cap at the middleware.
- **Rate limiting** per client+route, structured errors with request ids, JSON logs with correlation ids.
- **Reliability.** Provider retries with backoff, model fallback chain, deterministic engine as last resort,
  explicit job timeouts, and failure states persisted on the session (never a silent hang).
- **Provenance.** Every source keeps URL, canonical URL, publication date, effective date, retrieval timestamp and
  authority score; passages keep character offsets.

---

## 8. Repository layout

```
epoch-ai/
├── backend/
│   ├── app/
│   │   ├── api/v1/            claims, research, history, analytics, system, benchmark
│   │   ├── core/              config, logging, errors, security (SSRF/injection), rate limit
│   │   ├── db/                models (10 tables), session, seed, pgvector
│   │   ├── schemas/           Pydantic enums + request/response models
│   │   └── services/
│   │       ├── llm/           gateway (Bifrost→OpenAI→Gemini→deterministic), prompts
│   │       └── research/      claim_extraction, planner, retrieval, temporal,
│   │                          contradiction, scoring, verdict, pipeline, jobs, report, corpus.json
│   ├── tests/                 22 automated tests (units + full API flow)
│   └── benchmark/             build_dataset.py, dataset.jsonl (114 claims), run_benchmark.py, results/
├── frontend/                  React SPA (7 pages, 6 components, typed API client)
├── docs/                      ARCHITECTURE, API, BENCHMARK, DEPLOYMENT, MILESTONES
├── Dockerfile                 single-image build (API + SPA)
├── docker-compose.yml         API + Postgres/pgvector
├── render.yaml · vercel.json  free-tier deploy blueprints
└── Makefile                   install / test / run / build / bench / docker
```

Database tables: `users`, `research_sessions`, `claims`, `evidence_sources`, `evidence_passages`,
`claim_evidence_relationships`, `temporal_observations`, `verdicts`, `model_execution_logs`, `benchmark_results`.

---

## 9. Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — data flow, module contracts, decision tables, trade-offs
- [`docs/API.md`](docs/API.md) — endpoints, payloads, error envelopes, limits
- [`docs/BENCHMARK.md`](docs/BENCHMARK.md) — dataset construction, metrics, confusion matrix, failure modes
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Render, Vercel, Neon, docker, environment matrix, cost notes
- [`docs/MILESTONES.md`](docs/MILESTONES.md) — milestone-by-milestone build log: files, commands, tests, errors fixed

---

## 10. Known limitations (stated, not hidden)

- The benchmark's retrieval step is deterministic, so it measures **reasoning**, not web-search variance. Live-mode
  accuracy is expected to be lower and is not claimed here.
- Calibration is fitted **in-sample** on the same benchmark that reports the Brier score — that number is optimistic.
- The deterministic engine is rule-based; hard semantic cases (absolute denials vs. cessation, scope-only
  differences) still produce the occasional error. The `PARTIALLY_OUTDATED` boundary is the weakest class.
- Evidence embeddings are stored as portable arrays by default; the pgvector ANN path is optional and index-only.
- No authentication in v1: a single local analyst account owns all sessions. Multi-user isolation is the next
  structural step (the schema already carries `user_id` on sessions).

---

EPOCH AI — *Know what is true. Know when it changed.*
