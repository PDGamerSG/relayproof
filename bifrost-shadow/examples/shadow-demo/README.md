# Shadow traffic demo

A reproducible, key-free run of the shadow plugin through a real Bifrost gateway.

```
loadgen ──► Bifrost :8080 ──► mock upstream :18080
              │  primary: openai/gpt-4o (answers the client)
              └─ shadow: gpt-4o-mini, llama-3.1-8b, judge-1, text-embedding-3-small
```

The mock upstream (`mockupstream/`) is an OpenAI-compatible server with deterministic
models:

| Model | Plays | Behaviour |
|---|---|---|
| `gpt-4o` | premium primary | always correct, verbose, ~900 ms |
| `gpt-4o-mini` | strong cheap candidate | ~2% wrong answers, concise, ~350 ms |
| `llama-3.1-8b` | weak cheap candidate | ~25% wrong, breaks JSON mode, ~6% HTTP 503 |
| `judge-1` | pairwise judge | scores both answers against the dataset's gold facts |
| `text-embedding-3-small` | embeddings | hashed bag-of-words vectors |

The load generator (`loadgen/`) replays a mixed workload from `dataset/`: factual
questions, arithmetic, JSON extraction with `response_format`, tool calling, and short
explanations, a quarter of it streamed.

## Run it

You need a gateway binary built with the shadow plugin (`../../scripts/setup.sh` builds one).

```bash
BIFROST_BIN=/path/to/bifrost-http ./run.sh
```

`run.sh` starts the mock and the gateway with [`gateway/config.json`](gateway/config.json),
sends 300 requests, waits for the shadow queue to drain, prints the scorecard, then walks
through a rollout:

1. `loadgen -report -require-ready openai/gpt-4o-mini` stops the script unless the
   candidate's verdict is `ready`;
2. `POST /api/shadow/promote` for `llama-3.1-8b` is refused with `409` and its verdict;
3. a dry run shows the plan for `gpt-4o-mini`: one rule, 90/10 split, no warnings;
4. `POST /api/shadow/promote` creates the canary rule and records the promotion;
5. 200 follow-up requests confirm that about 10% are now served by `gpt-4o-mini`;
6. `GET /api/shadow/rollouts` shows the canary `healthy`;
7. the mock's incident switch makes `gpt-4o-mini` fail 60% of requests, the canary guard
   (`canary.auto_rollback` in the config) rolls it back, and 100 more requests are all
   served by `gpt-4o`;
8. a guarded ramp: `gpt-4o-mini` is promoted again with
   `"ramp": {"steps": [0.1, 0.5, 1], "min_requests": 10, "hold_seconds": 2}`, and the canary
   guard raises it to 50% and then 100% on its own while it stays healthy; 50 more requests are
   all served by `gpt-4o-mini`;
9. the rollout log is printed.

Tune it with `REQUESTS`, `CONCURRENCY`, `PORT`, `MOCK_ADDR` and `CANARY_WEIGHT`.

The demo is local-only: the gateway listens on 127.0.0.1, inference auth is off
(`enforce_auth_on_inference: false`), and `/api` calls use a throwaway setup token that
`run.sh` generates (`BIFROST_SETUP_TOKEN`). Do not reuse this config for a shared gateway.

## Expected scorecard

```
CANDIDATE            SAMPLES  AGREE   LOWER95  ERRORS  JUDGE (P/C)  P50 (P/C)     SAVINGS  $/1M REQ  VERDICT
openai/gpt-4o-mini   146      100.0%  97.4%    0.0%    9.0 / 9.0    883 / 342 ms  97.2%    $301      READY
openai/llama-3.1-8b  146      67.1%   59.1%    2.7%    9.0 / 6.8    883 / 201 ms  99.3%    $307      NOT READY
```

And the rollout (13 November 2026, macOS arm64, 1 min 41 s for the whole script):

```
==> promotion is gated on the verdict: trying openai/llama-3.1-8b
HTTP 409: not_ready - agreement 67.1% is below 90%
==> promoting openai/gpt-4o-mini: POST /api/shadow/promote
HTTP 200: create 9a94dfaf-… agreement 100.0% (95% lower bound 97.4%) clears 90%
gpt-4o-mini served 20 of 200 requests (expected 20)
[('gpt-4o-mini', 'healthy', 'live error rate 0.0% within 5.0% over 20 requests')]
==> simulating a provider incident: gpt-4o-mini now fails 60% of requests
during the incident: gpt-4o-mini served 6 of 150 requests, 5 failed
rolled back: canary guard: live error rate 19.2% (95% lower bound 8.5%) exceeds 5.0%
gpt-4o-mini served 0 of 100 requests, 0 failed
2026-11-13T17:51:16  promote        gpt-4o-mini   weight=0.1    by api
2026-11-13T17:51:49  auto_rollback  gpt-4o-mini   weight=0      by canary_guard
```

Five user requests failed during the simulated incident before the guard acted.

The ramp at the end (15 November 2026, macOS arm64, 2 min 4 s for the whole script; 13 s from the
ramped promotion to `ramp_complete`):

```
==> guarded ramp: promote openai/gpt-4o-mini again, and let the canary guard take it from 10% to 100%
HTTP 200: dry run steps [0.1, 0.5, 1] min_requests 10 hold_seconds 2
  10%: step 1 of 3 (10%): 4 of 10 candidate requests
  50%: step 2 of 3 (50%) passed: moving to 100% at the guard's next check
  100%: complete: the canary reached the last step, 100%
after the ramp: gpt-4o-mini served 50 of 50 requests, 0 failed
2026-11-15T01:16:18  promote        gpt-4o-mini   weight=0.1    by api
2026-11-15T01:16:26  ramp           gpt-4o-mini   weight=0.5    by canary_guard
2026-11-15T01:16:31  ramp_complete  gpt-4o-mini   weight=1      by canary_guard
```

Sampling is random, so the numbers move a little between runs; the verdicts do not.
`$/1M REQ` is the saving per million requests at the prices in `gateway/config.json`.

Both candidates are far cheaper; only one is safe. `llama-3.1-8b` is blocked by its
agreement interval and error rate, and every failing pair is inspectable:

```bash
curl -s -H "X-Bifrost-Setup-Token: $BIFROST_SETUP_TOKEN" \
  'localhost:8080/api/shadow/records?candidate=openai/llama-3.1-8b&outcome=fail&limit=5'
```

## Keep a backend running for frontend work

```bash
BIFROST_BIN=/path/to/bifrost-http ./dev.sh
```

`dev.sh` starts the same mock and gateway, seeds 300 requests, then sends one live request per
second until Ctrl-C (`TRAFFIC_EVERY=0` turns that off, `SEED`, `PORT` and `MOCK_ADDR` are
adjustable). It prints the setup token (`shadow-dev-token` unless `BIFROST_SETUP_TOKEN` is set).
See [`../../api/README.md`](../../api/README.md) for connecting a frontend.

The mock's incident switch works with either script:

```bash
curl -X POST 'http://127.0.0.1:18080/admin/incident?model=gpt-4o-mini&error_pct=60'   # 60% of requests fail with 503
curl -X POST 'http://127.0.0.1:18080/admin/incident?model=gpt-4o-mini&error_pct=0'    # back to normal
```

## Run the pieces by hand

The demo config keeps the default SQLite config store, so the gateway locks `/api` until a
setup token is set. Export one before starting it; `loadgen` reads the same variable.

```bash
export BIFROST_SETUP_TOKEN="local-demo-$RANDOM$RANDOM"
GOWORK=off go build -o bin/ ./mockupstream ./loadgen
bin/mockupstream -addr 127.0.0.1:18080 -speed 1
bifrost-http -app-dir gateway -port 8080 -host 127.0.0.1
bin/loadgen -n 300 -c 12          # -shadow force mirrors every request (allow_force_header is on here)
bin/loadgen -report               # print the current scorecard only
bin/loadgen -report -require-ready openai/gpt-4o-mini   # exit 2 unless it is ready
```

`-speed 0` on the mock removes simulated latency for fast iteration.
