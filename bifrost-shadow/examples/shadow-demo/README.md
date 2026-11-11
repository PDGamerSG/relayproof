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
sends 300 requests, waits for the shadow queue to drain, prints the scorecard, then
promotes the ready candidate:

1. `loadgen -report -require-ready openai/gpt-4o-mini` stops the script unless the
   candidate's verdict is `ready`;
2. `GET /api/shadow/canary-rule` builds a 90/10 weighted routing rule;
3. `POST /api/routing/rules` creates it;
4. 200 follow-up requests confirm that about 10% are now served by `gpt-4o-mini`.

Tune it with `REQUESTS`, `CONCURRENCY`, `PORT`, `MOCK_ADDR` and `CANARY_WEIGHT`.

The demo is local-only: the gateway listens on 127.0.0.1, inference auth is off
(`enforce_auth_on_inference: false`), and `/api` calls use a throwaway setup token that
`run.sh` generates (`BIFROST_SETUP_TOKEN`). Do not reuse this config for a shared gateway.

## Expected scorecard

```
CANDIDATE            SAMPLES  AGREE  LOWER95  ERRORS  JUDGE (P/C)  P50 (P/C)     SAVINGS  $/1M REQ  VERDICT
openai/gpt-4o-mini   162      99.4%  96.6%    0.0%    9.0 / 9.0    918 / 339 ms  97.2%    $294      READY
openai/llama-3.1-8b  162      63.0%  55.3%    4.3%    9.0 / 6.6    900 / 195 ms  99.3%    $300      NOT READY
```

Sampling is random, so the numbers move a little between runs; the verdicts do not.
`$/1M REQ` is the saving per million requests at the prices in `gateway/config.json`.

Both candidates are far cheaper; only one is safe. `llama-3.1-8b` is blocked by its
agreement interval and error rate, and every failing pair is inspectable:

```bash
curl -s -H "X-Bifrost-Setup-Token: $BIFROST_SETUP_TOKEN" \
  'localhost:8080/api/shadow/records?candidate=openai/llama-3.1-8b&outcome=fail&limit=5'
```

## Run the pieces by hand

The demo config keeps the default SQLite config store, so the gateway locks `/api` until a
setup token is set. Export one before starting it; `loadgen` reads the same variable.

```bash
export BIFROST_SETUP_TOKEN="local-demo-$RANDOM$RANDOM"
GOWORK=off go build -o bin/ ./mockupstream ./loadgen
bin/mockupstream -addr 127.0.0.1:18080 -speed 1
bifrost-http -app-dir gateway -port 8080 -host 127.0.0.1
bin/loadgen -n 300 -c 12          # -shadow force to mirror every request
bin/loadgen -report               # print the current scorecard only
bin/loadgen -report -require-ready openai/gpt-4o-mini   # exit 2 unless it is ready
```

`-speed 0` on the mock removes simulated latency for fast iteration.
