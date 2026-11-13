# Bifrost Shadow site

The project's landing page: what shadow traffic is, a live simulation of the request and shadow
paths, the demo scorecard, the readiness maths, the guards, and the quick start.

```bash
pnpm install
pnpm dev        # http://localhost:5273
pnpm build      # static files in dist/, relative asset paths
```

Vite, React and TypeScript. Styles are plain CSS, one file per component, with tokens in
`src/styles/base.css`. Fonts (Archivo, JetBrains Mono) are bundled, so the page works offline.

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
