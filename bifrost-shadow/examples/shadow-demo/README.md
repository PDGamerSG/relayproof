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
| `gpt-4o-mini` | strong cheap candidate | ~4% wrong answers, concise, ~350 ms |
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

1. `GET /api/shadow/canary-rule` builds a 90/10 weighted routing rule;
2. `POST /api/routing/rules` creates it;
3. 200 follow-up requests confirm that about 10% are now served by `gpt-4o-mini`.

Tune it with `REQUESTS`, `CONCURRENCY`, `PORT`, `MOCK_ADDR` and `CANARY_WEIGHT`.

The demo is local-only: the gateway listens on 127.0.0.1, inference auth is off
(`enforce_auth_on_inference: false`), and `/api` calls use a throwaway setup token that
`run.sh` generates (`BIFROST_SETUP_TOKEN`). Do not reuse this config for a shared gateway.

## Expected scorecard

```
CANDIDATE            SAMPLES  AGREE  LOWER95  ERRORS  JUDGE (P/C)  P50 (P/C)     SAVINGS  VERDICT
openai/gpt-4o-mini   155      96.1%  91.8%    0.0%    9.0 / 8.7    882 / 347 ms  97.3%    READY
openai/llama-3.1-8b  155      69.0%  61.4%    5.8%    9.0 / 7.1    882 / 197 ms  99.3%    NOT READY
```

Both candidates are far cheaper; only one is safe. `llama-3.1-8b` is blocked by its
error rate and its agreement interval, and every failing pair is inspectable:

```bash
curl -s 'localhost:8080/api/shadow/records?candidate=openai/llama-3.1-8b&outcome=fail&limit=5'
```

## Run the pieces by hand

```bash
GOWORK=off go build -o bin/ ./mockupstream ./loadgen
bin/mockupstream -addr 127.0.0.1:18080 -speed 1
bifrost-http -app-dir gateway -port 8080
bin/loadgen -n 300 -c 12          # -shadow force to mirror every request
bin/loadgen -report               # print the current scorecard only
```

`-speed 0` on the mock removes simulated latency for fast iteration.
