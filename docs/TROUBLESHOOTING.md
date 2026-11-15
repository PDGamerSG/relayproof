# Troubleshooting

Fixes for problems people hit when they set up, build or deploy RelayProof. Each entry names the symptom as you see it, the cause, and the fix. Paths are relative to the repository root. Quoted messages are the exact text the scripts and pages print.

All commands run from the repository root unless they say otherwise. `bifrost-shadow/scripts/setup.sh` clones upstream Bifrost into `./bifrost/`, which is generated and ignored by git (`.gitignore:28-29`).

## Setup

### Go stops with "go.mod requires go >= 1.27.3"

The plugin and the demo modules declare `go 1.27.3` (`bifrost-shadow/plugins/shadow/go.mod:3`, `bifrost-shadow/examples/shadow-demo/go.mod:3`). The script and the site only say "Go 1.27+" or "Go 1.27 or newer" (`bifrost-shadow/scripts/setup.sh:12`, `bifrost-shadow/site/src/components/QuickStart.tsx:195`), so Go 1.27.0 to 1.27.2 looks fine but is too old. When `GOTOOLCHAIN` is `local`, Go refuses to switch to a newer toolchain and stops with that message. When it is `auto` (Go's default), Go downloads 1.27.3 or newer on the first command, which needs network access.

CI installs the newest 1.27 release (`go-version: "1.27.x"`, `.github/workflows/shadow.yml:23-26`), and the hosted image builds on `golang:1.27-bookworm` (`bifrost-shadow/deploy/Dockerfile:11`). The repository itself never sets `GOTOOLCHAIN`.

```bash
go version                 # needs go1.27.3 or newer
go env GOTOOLCHAIN         # "local" means no automatic download
GOTOOLCHAIN=auto bifrost-shadow/scripts/setup.sh   # or install Go 1.27.3+ and rerun
```

### The last step, "Building the gateway", fails with a cgo or C compiler error

The gateway is built with `CGO_ENABLED=1` because Bifrost's default config store is SQLite, which uses cgo (`bifrost-shadow/scripts/setup.sh:12`, `bifrost-shadow/scripts/setup.sh:85-87`). Without a C compiler on `PATH` the build cannot compile the SQLite driver. The tests before it may still pass, because they run first (`bifrost-shadow/scripts/setup.sh:77-83`).

Install a C compiler, then rerun the script. On macOS that is the Xcode command line tools; on Debian or Ubuntu it is `gcc` (the clean-room build in `bifrost-shadow/TESTING.md:383-385` used gcc 12.2.0).

```bash
xcode-select --install                   # macOS
sudo apt-get install -y build-essential  # Debian or Ubuntu
bifrost-shadow/scripts/setup.sh
```

### A second run of `setup.sh` fails at "Applying patches"

Rerunning is meant to be safe: for each patch the script first checks whether it is already applied and, if so, prints `  <name> (already applied)` and moves on (`bifrost-shadow/scripts/setup.sh:44-53`). A patch fails when it is neither cleanly applied nor cleanly applicable. That happens when:

- you pulled a newer version of a file in `bifrost-shadow/patches/` and the older version is already applied in `./bifrost/`;
- you edited one of the patched upstream files inside `./bifrost/`;
- you set `BIFROST_REF` to another upstream commit (`bifrost-shadow/scripts/setup.sh:10`, `bifrost-shadow/scripts/setup.sh:19`). The checkout at `bifrost-shadow/scripts/setup.sh:33-35` can also refuse while patched files are modified.

The script runs with `set -euo pipefail` (`bifrost-shadow/scripts/setup.sh:15`), so `git apply` stops it at the first failing patch. `./bifrost/` is generated, so the simplest fix is a fresh clone. This deletes anything you changed inside `./bifrost/`, including its build output.

```bash
rm -rf bifrost
bifrost-shadow/scripts/setup.sh
```

### Files you deleted or renamed in `bifrost-shadow/` still affect the build

The overlay step copies `plugins`, `transports`, `examples`, `docs`, `ui` and `tests` from `bifrost-shadow/` over the clone with `cp -R` (`bifrost-shadow/scripts/setup.sh:37-42`). It never deletes anything, so a file removed or renamed in `bifrost-shadow/` stays in `./bifrost/` and is still compiled and tested. Use a fresh clone, as above.

### The dashboard build fails during `npm ci` or `npm run build`

Unless `SKIP_UI=1` is set, the script runs `npm ci --no-audit --no-fund && npm run build` in the clone's `ui/` folder (`bifrost-shadow/scripts/setup.sh:72-75`). The script asks for Node and npm at the version in Bifrost's `.nvmrc`, which is 26 at the pinned commit (`bifrost-shadow/scripts/setup.sh:12-14`, `bifrost-shadow/README.md:176-177`). The clean-room build with the dashboard used Node 26.13.0 and npm 11.20.0 (`bifrost-shadow/TESTING.md:383-385`). The script comment and the README point at `ui/.nvmrc`, but at the pinned commit upstream keeps `.nvmrc` at the top of its repository. The error an older Node produces is not recorded in the repository.

Either switch to Node 26 or skip the dashboard. Without the dashboard you lose only the Bifrost UI page. The plugin, the API, the demo and the console all work.

```bash
node --version                            # expect v26
SKIP_UI=1 bifrost-shadow/scripts/setup.sh # gateway without the dashboard
```

### The gateway's UI shows "Dashboard not built (SKIP_UI=1)."

With `SKIP_UI=1`, the script writes a placeholder page into the gateway's embedded UI folder, unless one is already there (`bifrost-shadow/scripts/setup.sh:66-71`). CI and the hosted image build this way (`.github/workflows/shadow.yml:28-29`, `bifrost-shadow/deploy/Dockerfile:17`). To see **Models > Shadow Traffic**, rerun `bifrost-shadow/scripts/setup.sh` without `SKIP_UI` and with Node 26.

## Demo scripts

`bifrost-shadow/examples/shadow-demo/run.sh` runs the full key-free demo once. `bifrost-shadow/examples/shadow-demo/dev.sh` keeps a seeded gateway running for frontend work. `setup.sh` copies both into `./bifrost/examples/shadow-demo/`, which is where you run them from.

### "BIFROST_BIN: set BIFROST_BIN to a bifrost-http binary built with the shadow plugin"

Both scripts require `BIFROST_BIN` and stop at once without it (`bifrost-shadow/examples/shadow-demo/run.sh:20`, `bifrost-shadow/examples/shadow-demo/dev.sh:19`). `setup.sh` prints the right command when it finishes (`bifrost-shadow/scripts/setup.sh:89-95`).

```bash
BIFROST_BIN="$(pwd)/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/run.sh
```

### "gateway did not become healthy"

Both scripts poll `GET /health` once a second for 60 seconds. If it never answers, they print this message and the last 30 lines of the gateway log, then exit 1 (`bifrost-shadow/examples/shadow-demo/run.sh:49-53`, `bifrost-shadow/examples/shadow-demo/dev.sh:40-44`). The work directory is kept on exit: `run.sh` prints "logs and records kept in [dir]" and `dev.sh` prints "stopped; gateway data kept in [dir]" (`bifrost-shadow/examples/shadow-demo/run.sh:32-36`, `bifrost-shadow/examples/shadow-demo/dev.sh:25-30`). Read `gateway.log` and `mock.log` in that folder. The usual causes:

- **A relative `BIFROST_BIN`.** The scripts start the gateway after `cd "$work"`, a temporary directory (`bifrost-shadow/examples/shadow-demo/run.sh:47`, `bifrost-shadow/examples/shadow-demo/dev.sh:38`). A path like `bifrost/tmp/bifrost-http` is then looked up inside that directory and the gateway never starts. Pass an absolute path, as the README does: "the binary path must be absolute: run.sh changes directory" (`bifrost-shadow/README.md:165`).
- **The port is taken.** See the next entry.
- **A slow first boot.** Bifrost runs its store migrations and loads the model catalog on boot, which "on a small instance ... takes a few minutes" (`bifrost-shadow/deploy/entrypoint.sh:73-74`). The demo scripts have no setting for their 60-second wait. Rerun on a less loaded machine.

### Port 8080 or 18080 is already in use

Both scripts put the gateway on `PORT` (default 8080) and the mock upstream on `MOCK_ADDR` (default `127.0.0.1:18080`) (`bifrost-shadow/examples/shadow-demo/run.sh:15-16`, `bifrost-shadow/examples/shadow-demo/dev.sh:15-16`). Neither checks that the ports are free. If another process holds the gateway port, the new gateway cannot bind to it. Worse, if that process also answers `GET /health` with 200, the health check passes against it and the script sends its traffic to the wrong server. If another process holds the mock's port, the gateway's provider calls go to that process instead of the mock.

Pick free ports. The verification log used 8180 and 18180 (`bifrost-shadow/TESTING.md:19`). `run.sh` rewrites the mock address in its copy of the gateway config, so `MOCK_ADDR` is all you need to change (`bifrost-shadow/examples/shadow-demo/run.sh:45`).

```bash
lsof -nP -iTCP:8080 -sTCP:LISTEN     # who holds the port
PORT=8180 MOCK_ADDR=127.0.0.1:18180 \
  BIFROST_BIN="$(pwd)/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/run.sh
```

### `run.sh` fails with "python3: command not found"

`run.sh` reads JSON with `python3` and talks to the gateway with `curl` (`bifrost-shadow/examples/shadow-demo/run.sh:28`, `bifrost-shadow/examples/shadow-demo/run.sh:67`, `bifrost-shadow/examples/shadow-demo/run.sh:211`). Neither tool is in the README's requirements list (`bifrost-shadow/README.md:176-177`). Install Python 3 and curl, then rerun.

### `/api/shadow/*` answers 401 or 403

The demo gateway keeps Bifrost's default SQLite config store and has no dashboard login, so Bifrost locks `/api` behind a setup token (`bifrost-shadow/examples/shadow-demo/run.sh:25-27`, `bifrost-shadow/examples/shadow-demo/README.md:133-134`). Every `/api` call needs the header `X-Bifrost-Setup-Token`, and the token must be in `BIFROST_SETUP_TOKEN` when the gateway starts. The verification log records the 401 and 403 answers you get without it (`bifrost-shadow/TESTING.md:213`). At the pinned commit, Bifrost answers 401 "dashboard auth is not configured; send the setup token in the X-Bifrost-Setup-Token header" without a token, and 403 "invalid setup token" with a wrong one. That is upstream code, not part of this repository.

- `run.sh` makes a throwaway token, `shadow-demo-<time>-<random>`, unless `BIFROST_SETUP_TOKEN` is already set (`bifrost-shadow/examples/shadow-demo/run.sh:27`). To query that gateway by hand while the script runs, export your own token before starting it.
- `dev.sh` uses `shadow-dev-token` unless `BIFROST_SETUP_TOKEN` is set, and prints it (`bifrost-shadow/examples/shadow-demo/dev.sh:21`, `bifrost-shadow/examples/shadow-demo/dev.sh:67-77`).
- If you start the pieces by hand, export the token before starting the gateway. `loadgen` reads the same variable (`bifrost-shadow/examples/shadow-demo/README.md:136-143`, `bifrost-shadow/examples/shadow-demo/loadgen/main.go:62`).
- The landing page's "Promote by API" snippet sends no token header (`bifrost-shadow/site/src/components/QuickStart.tsx:57-65`). Against the demo gateway, add `-H "X-Bifrost-Setup-Token: $BIFROST_SETUP_TOKEN"`.
- Once a gateway has an admin account with dashboard auth on, the setup token no longer works. Use the dashboard username and password instead (`bifrost-shadow/api/README.md:67-71`, `bifrost-shadow/site/src/live/Connect.tsx:164`).

```bash
export BIFROST_SETUP_TOKEN="local-demo-$RANDOM$RANDOM"
BIFROST_BIN="$(pwd)/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/run.sh
# in another terminal, while it runs
curl -s -H "X-Bifrost-Setup-Token: $BIFROST_SETUP_TOKEN" http://localhost:8080/api/shadow/summary
```

### The numbers differ on every run, or `run.sh` stops with "not promoting; collect more evidence first"

The demo's results are random by design:

- The plugin picks each sampled request with a random draw against `sample_rate` (`bifrost-shadow/plugins/shadow/main.go:246`, `bifrost-shadow/plugins/shadow/main.go:394`). The demo samples 50% (`bifrost-shadow/examples/shadow-demo/gateway/config.json:30`), so a 300-request run scores a different set of pairs each time.
- The judge sees the two answers in a random order (`bifrost-shadow/plugins/shadow/worker.go:331`).
- The canary's traffic split is random per request (`bifrost-shadow/examples/shadow-demo/run.sh:116`), and so are the mock's incident failures (`bifrost-shadow/examples/shadow-demo/mockupstream/main.go:155`).

The mock's answers and the workload order are fixed (`bifrost-shadow/examples/shadow-demo/mockupstream/main.go:11`, `bifrost-shadow/examples/shadow-demo/loadgen/main.go:58`). As the demo README puts it, "the numbers move a little between runs; the verdicts do not" (`bifrost-shadow/examples/shadow-demo/README.md:102`). In six recorded runs, `gpt-4o-mini` had a lower bound between 95.9% and 97.7% (`bifrost-shadow/TESTING.md:292-299`).

`run.sh` promotes only a candidate whose verdict is `ready`. Otherwise it prints "not promoting; collect more evidence first, for example REQUESTS=600 [path to run.sh]" and exits 1 (`bifrost-shadow/examples/shadow-demo/run.sh:59-64`). More requests give more scored pairs and a tighter bound:

```bash
REQUESTS=600 BIFROST_BIN="$(pwd)/bifrost/tmp/bifrost-http" ./bifrost/examples/shadow-demo/run.sh
```

The later checks can also fail by chance. The split check accepts anything within 3 standard deviations of the weight (`bifrost-shadow/examples/shadow-demo/run.sh:116-122`). For the rollback check, the guard may need more failures than 150 requests give it, so the script sends up to 8 more rounds of 50 before it prints "the canary guard did not roll back" (`bifrost-shadow/examples/shadow-demo/run.sh:136-156`). Rerun before you look for a bug.

### "promotion failed (it needs the config store and the routing plugin)"

The promote call answered 300 or higher (`bifrost-shadow/examples/shadow-demo/run.sh:85-91`). Promotion writes a routing rule, so the gateway needs a config store. Without one, `POST /api/shadow/promote` answers 503 "promotion needs the config store, which holds routing rules; enable config_store" (`bifrost-shadow/transports/bifrost-http/handlers/shadow.go:231-233`). The full answer is printed on the line before the message. If you run the demo with your own config, keep the config store on.

## Live console and site

### `pnpm dev` stops because port 5273 is in use

The site's dev server is pinned to port 5273 with `strictPort`, so Vite stops instead of moving to another port (`bifrost-shadow/site/vite.config.ts:15-17`). Free the port, or pass another one, which `strictPort` then holds just as strictly:

```bash
cd bifrost-shadow/site
pnpm dev --port 5274
```

### The local console says "Waking the demo gateway", then "Demo backend offline"

In development, the console's Trial mode calls `/api/shadow/*` and `/api/demo/*` on its own origin, and Vite forwards both to `SHADOW_BACKEND`, by default `http://localhost:10000` (`bifrost-shadow/site/vite.config.ts:5-9`, `bifrost-shadow/site/vite.config.ts:18-21`). If nothing listens there, the status line shows "Waking the demo gateway" and then "Demo backend offline". The page shows "The demo backend is not answering yet." and keeps retrying (`bifrost-shadow/site/src/live/LiveApp.tsx:188-190`, `bifrost-shadow/site/src/live/LiveApp.tsx:237-241`).

Run the hosted image locally. Without an Anthropic key it plays every model with the mock and costs nothing (`bifrost-shadow/site/README.md:56-62`, `bifrost-shadow/deploy/entrypoint.sh:24-27`):

```bash
docker build -f bifrost-shadow/deploy/Dockerfile -t relayproof-demo .
docker run --rm -p 10000:10000 -e BIFROST_SETUP_TOKEN=dev relayproof-demo
cd bifrost-shadow/site && pnpm dev
```

Do not point `SHADOW_BACKEND` at the hosted demo. It calls real models (`bifrost-shadow/site/README.md:58`), and every console call there starts paid background traffic (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:340`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:672-674`). Another option is a `dev.sh` gateway and the console's Sign in mode with `http://localhost:8080` and its setup token.

### Sign in: "Could not reach ... that its config lists ... in client.allowed_origins"

Sign in calls your gateway straight from the browser (`bifrost-shadow/site/src/live/backend.ts:8-11`). If the call fails at the network level, the form shows "Could not reach [gateway]. Check that it is running, that the address is right, and that its config lists [this site's origin] in client.allowed_origins." (`bifrost-shadow/site/src/live/Connect.tsx:74-81`). Besides a gateway that is down, the usual cause is CORS. Origins on `localhost` are allowed, but any other origin must be listed by name in the gateway's `client.allowed_origins`, and while dashboard auth is off the wildcard `"*"` does not cover management routes (`bifrost-shadow/api/README.md:77-83`). The demo config lists the hosted site's origin by name (`bifrost-shadow/examples/shadow-demo/gateway/config.json:7`).

Add the console's origin, for example `https://relayproof.pallabdas.me` or `http://localhost:5273`, to `client.allowed_origins` in the gateway's `config.json`, then start the gateway with that config. The console's Set up tab writes this block for you (`bifrost-shadow/site/src/live/configBuilder.ts:581`, `bifrost-shadow/site/src/live/configBuilder.ts:743`).

```json
"client": { "allowed_origins": ["https://relayproof.pallabdas.me"] }
```

On the hosted page, a gateway on `localhost` can also be blocked by the browser itself. The form then adds "allow local network access when it asks, or run this console locally (pnpm dev)" (`bifrost-shadow/site/src/live/Connect.tsx:75-80`). The verification log notes that this path was not verified in a browser (`bifrost-shadow/TESTING.md:71`).

### Sign in: "This page is served over https, so the browser blocks calls to a plain-http gateway. Use https, or localhost."

The hosted console is served over https. The form refuses a plain `http://` gateway unless it is `localhost`, `127.*` or `[::1]`, because the browser would block the call as mixed content (`bifrost-shadow/site/src/live/Connect.tsx:54-58`). An address typed without a scheme gets `https://` unless it is local (`bifrost-shadow/site/src/live/backend.ts:113-119`). Put the gateway behind https, or run the console locally over http (`pnpm dev` in `bifrost-shadow/site`, then open `http://localhost:5273/live`), where the check does not apply.

### Sign in: "The gateway refused that setup token." or "...that username and password."

The gateway answered 401 or 403 (`bifrost-shadow/api/client/shadowClient.ts:584`, `bifrost-shadow/site/src/live/Connect.tsx:70-71`). Check the token or the login. A setup token stops working once the gateway has an admin account with dashboard auth on. Use **Dashboard login** then (`bifrost-shadow/site/src/live/Connect.tsx:144-166`).

### "Signed in, but the shadow plugin is not enabled on that gateway."

The gateway answered 404 "shadow plugin is not enabled" (`bifrost-shadow/transports/bifrost-http/handlers/shadow.go:68-74`, `bifrost-shadow/site/src/live/Connect.tsx:72-73`). Either the binary was not built with `setup.sh`, or the gateway's config does not enable the plugin. Add an entry named `shadow` with `"enabled": true` to `plugins` in `config.json`, as in `bifrost-shadow/examples/shadow-demo/gateway/config.json:25-59`.

## Build

### CI fails at "The site's copy of the client matches"

The `client` job compares the two copies of the TypeScript client byte for byte with `cmp` (`.github/workflows/shadow.yml:59-60`). `bifrost-shadow/site/src/live/shadowClient.ts` is a copy of `bifrost-shadow/api/client/shadowClient.ts` (`bifrost-shadow/site/README.md:54`), so a change to one without the other fails the job. Edit the API copy, then copy it over:

```bash
cp bifrost-shadow/api/client/shadowClient.ts bifrost-shadow/site/src/live/shadowClient.ts
cmp bifrost-shadow/api/client/shadowClient.ts bifrost-shadow/site/src/live/shadowClient.ts && echo identical
```

### CI fails at "Strict typecheck" although the site builds

CI checks the client with TypeScript 5.6.3 and strict flags, on Node 22 (`.github/workflows/shadow.yml:54-58`). The site builds with TypeScript `^7.0.2` (`bifrost-shadow/site/package.json:23`). Code that one compiler accepts can fail the other. Run CI's exact command before you push:

```bash
npx --yes -p typescript@5.6.3 tsc --noEmit --strict --target es2022 --module esnext \
  --moduleResolution bundler --lib es2022,dom --noUnusedLocals --noUnusedParameters \
  bifrost-shadow/api/client/shadowClient.ts
```

### A site change passes CI but breaks the Vercel build

CI does not build the site (`.github/workflows/shadow.yml:15-60`). Vercel does, with `pnpm install --frozen-lockfile` and then `pnpm build`, which is `tsc --noEmit && vite build` (`bifrost-shadow/site/vercel.json:4-6`, `bifrost-shadow/site/package.json:8`). A type error, or a `package.json` change without a matching `pnpm-lock.yaml`, fails the deploy. Check locally first:

```bash
cd bifrost-shadow/site
pnpm install          # updates pnpm-lock.yaml after a package.json change; commit it
pnpm build
```

## Deploy

### The Render service restarts with "relayproof-demo: gateway did not become healthy"

The container's entrypoint waits up to `BOOT_TIMEOUT` seconds (default 300) for the gateway, then prints this message and exits 1 (`bifrost-shadow/deploy/entrypoint.sh:73-82`). The first deploy on Render's free plan (0.1 CPU) failed this way, and the service moved to the starter plan (`bifrost-shadow/TESTING.md:64`, `render.yaml:9-12`). Keep the starter plan, or raise `BOOT_TIMEOUT`.

If any of the processes in the container exits later, the entrypoint prints "relayproof-demo: a demo process exited; stopping so the container restarts" and the platform restarts the container (`bifrost-shadow/deploy/entrypoint.sh:91-93`). Read the service log above that line.

### The container stops at once with "set BIFROST_SETUP_TOKEN to a random secret"

The entrypoint requires `BIFROST_SETUP_TOKEN` (`bifrost-shadow/deploy/entrypoint.sh:21`). The Render blueprint generates one (`render.yaml:26-29`). For a local `docker run`, pass `-e BIFROST_SETUP_TOKEN=<any value>`. With `DEMO_MODE=claude` and no key, it stops with "DEMO_MODE=claude needs ANTHROPIC_API_KEY" (`bifrost-shadow/deploy/entrypoint.sh:32`). Without `DEMO_MODE`, a missing key simply means mock mode (`bifrost-shadow/deploy/entrypoint.sh:24-27`).

### The hosted demo's daily request cap runs out early

In Claude mode the front door may send 400 requests per UTC day, with one background request every 15 seconds while someone has the console open (`bifrost-shadow/deploy/entrypoint.sh:40-42`). These defaults apply only when the variables are unset. A leftover `TRAFFIC_EVERY=1s` in Render's environment once threatened to spend the cap in minutes (`bifrost-shadow/TESTING.md:52`). Check the service's environment variables against `render.yaml:25-43` and remove any you did not mean to set. Once the cap is reached, bursts and questions answer 429 "the demo's daily request cap is reached; it resets at midnight UTC" (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:640`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:777`).

### The hosted console answers 429 to a visitor

The front door limits each client address to 30 POSTs a minute ("too many changes from this address; wait a minute") and 20 questions an hour ("this address has asked 20 questions in the last hour; try again later"). It also runs one burst at a time ("a burst is already running; try again when it finishes") (`bifrost-shadow/examples/shadow-demo/frontdoor/main.go:98`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:109`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:634`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:773`, `bifrost-shadow/examples/shadow-demo/frontdoor/main.go:969`). Wait, or test against a local image instead.

### A change to the site did not redeploy the backend, or the other way round

Render rebuilds the backend only for commits that touch `bifrost-shadow/**`, `render.yaml` or `.dockerignore`, and it ignores `bifrost-shadow/site/**` (`render.yaml:17-24`). The Docker build context excludes the site as well (`.dockerignore:1-5`). The site deploys on Vercel from `bifrost-shadow/site` (`bifrost-shadow/site/vercel.json:1-12`). How Vercel is connected to the repository is not recorded in the repository.
