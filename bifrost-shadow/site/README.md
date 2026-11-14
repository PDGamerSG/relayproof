# RelayProof site

The project's landing page and its live console.

The landing page says what RelayProof does in one line, then shows it: a real request recorded on
the hosted gateway with the answer the user got and the two shadow answers with their verdicts,
how it works in five steps with a simulation of the request and shadow paths, why shadow traffic
beats an offline eval or an A/B test, a savings calculator that prices both the switch and the
evidence it needs, the demo scorecard and readiness maths, the guards, and two ways to try it.

```bash
pnpm install
pnpm dev        # http://localhost:5273
pnpm build      # static files in dist/, relative asset paths
```

Vite, React and TypeScript. Styles are plain CSS, one file per component, with tokens in
`src/styles/base.css`. Fonts (Archivo, JetBrains Mono) are bundled, so the page works offline.

## Live console

`live.html` (served at `/live`) is a console for a real gateway, with two ways in:

- **Trial**: the hosted demo backend (`bifrost-shadow/deploy`, on Render). The page calls its own
  origin; `vercel.json` rewrites `/api/shadow/*` and `/api/demo/*` to the backend's front door,
  which attaches the gateway's setup token and exposes nothing else. No account needed.
- **Sign in**: any Bifrost gateway with the shadow plugin, called straight from the browser with
  that gateway's dashboard username and password (HTTP Basic), or its setup token before an admin
  exists. The gateway must list this site's origin in `client.allowed_origins`; from the https
  site, use an https gateway or `localhost`.

The console is split into tabs kept in the URL hash, so each can be linked:

Tabs are grouped by the job: watch, decide, act. Each is kept in the URL hash, so it can be
linked. Cmd+K (or Ctrl+K, or `/`) opens a command palette over the tabs, the loaded comparisons,
the candidates and the downloads.

| Tab | What it shows |
|---|---|
| Overview | Counters, one scorecard per candidate with its agreement trend (running agreement, 95% lower bound, the bar, one tick per comparison, promotions, ramp steps and rollbacks), drift between the newest comparisons and the ones before, and agreement split by kind of request |
| Ask (trial only) | Ask the hosted gateway a question and see the primary answer, then each candidate's answer and verdict; the latest traffic below it |
| Comparisons | Every stored comparison: search, filter by candidate, outcome and deciding signal, sort by the worst judge gap; one request at a time with the candidates' answers diffed word by word against the primary. `#comparisons/<record id>` links to one; j and k step through the list |
| Performance | Latency distributions and percentiles per model, paired latency on the same requests, output tokens, cost per request, whether the evaluation pays for itself, quality against cost, and traffic over time by outcome |
| Judge check | How far to trust the LLM judge: position and length effects, same-family warning, score gaps, and a blind labelling loop that measures your agreement with the judge |
| Policy lab | The loaded comparisons decided again under another gate (agreement bar, minimum samples, error budget, judge tolerance): which verdicts and pairs would flip, a verdict map, and the thresholds as config |
| Report | A readiness report per candidate (`#report/<candidate>`): verdict and next step, key numbers, monthly cost at your volume, the evidence trend, judge findings, worst disagreements, rollout history and method. Prints to PDF and copies as Markdown |
| Rollout | Live canaries, their health and ramp progress, simulated provider incidents (trial), rollout history, CSV and JSON downloads. The promote dialog can ask the guard to ramp the canary step by step; a gateway without ramp support is detected on the dry run |
| Set up | A configuration builder for your own gateway: the plugin's JSON (checked against the plugin's rules), the whole config.json or an API call, an evaluation spend estimate, and the commands to build, start and check it |

The record-level views (trend, segments, comparisons, judge check, report) load the newest 500
records from `GET /api/shadow/records` every 15 seconds, so they cover the gateway's recent window
when it holds more.

`src/live/shadowClient.ts` is a copy of `api/client/shadowClient.ts`; CI checks they match.

```bash
# Local backend for the console (from the repository root, after scripts/setup.sh).
# Prefer this to pointing SHADOW_BACKEND at the hosted demo: the hosted one calls real models.
docker build -f bifrost-shadow/deploy/Dockerfile -t relayproof-demo .
docker run --rm -p 10000:10000 -e BIFROST_SETUP_TOKEN=dev relayproof-demo
pnpm dev        # Vite proxies /api/shadow and /api/demo to localhost:10000 (SHADOW_BACKEND overrides)
```

## Where the content comes from

| File | Source |
|---|---|
| `src/lib/stats.ts` | `wilsonLowerBound` and `verdictFor` in `plugins/shadow` |
| `src/lib/canary.ts` | `BuildCanaryRule` in `plugins/shadow/api.go` |
| `src/data/demo.ts` | The demo run in the project README, the demo dataset, the benchmark table |
| `src/lib/sim.ts` | A simulation. Outcome rates follow the demo run; verdicts use `stats.ts` |
| `src/data/hosted.ts` | Records and prices copied from the hosted gateway on 14 Nov 2026 (the hero and the savings calculator). The landing page never calls the hosted API: any call there marks the console as watched and starts paid traffic |
| `src/live/records.ts` | Agreement as the scorecard counts it (`passes / (scored + errors)`), record by record |
| `src/live/judgeStats.ts` | Position, length and score-gap checks on judge verdicts, Wilson intervals, Cohen's kappa for the labelling loop |
| `src/live/policy.ts` | The plugin's pass rules (`plugins/shadow/worker.go`) and verdict order (`store.go`), applied again under other thresholds |
| `src/live/configBuilder.ts` | The plugin's config fields, defaults and validation (`plugins/shadow/config.go`) |

If the plugin's thresholds, verdict rules or demo numbers change, update those files.

## Before publishing

`REPO_URL` in `src/data/site.ts` points at the current repository. Change it when the project
moves to its public repository; every source and documentation link on the page derives from it.
