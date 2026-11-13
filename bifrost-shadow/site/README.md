# RelayProof site

The project's landing page: what shadow traffic is, a live simulation of the request and shadow
paths, the demo scorecard, the readiness maths, the guards, and the quick start.

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

`src/live/shadowClient.ts` is a copy of `api/client/shadowClient.ts`; CI checks they match.

```bash
# Local backend for the console (from the repository root, after scripts/setup.sh)
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

If the plugin's thresholds, verdict rules or demo numbers change, update those files.

## Before publishing

`REPO_URL` in `src/data/site.ts` points at the current repository. Change it when the project
moves to its public repository; every source and documentation link on the page derives from it.
