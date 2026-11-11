#!/usr/bin/env bash
# End-to-end shadow traffic demo: mock upstream -> Bifrost gateway (shadow plugin)
# -> load generator -> scorecard -> canary routing rule.
#
#   BIFROST_BIN=/path/to/bifrost-http ./run.sh            # default 300 requests
#   BIFROST_BIN=... REQUESTS=600 PORT=8081 ./run.sh
#
# BIFROST_BIN must be a gateway built with the shadow plugin (see ../../scripts/setup.sh).
# Nothing here needs an API key: every model is served by the deterministic mock.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
MOCK_ADDR="${MOCK_ADDR:-127.0.0.1:18080}"
REQUESTS="${REQUESTS:-300}"
CONCURRENCY="${CONCURRENCY:-12}"
WEIGHT="${CANARY_WEIGHT:-0.1}"
BIFROST_BIN="${BIFROST_BIN:?set BIFROST_BIN to a bifrost-http binary built with the shadow plugin}"
GATEWAY="http://localhost:${PORT}"
EXPERIMENT="gpt-4o cost-down"
CANDIDATE="openai/gpt-4o-mini"

work="$(mktemp -d)"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  echo "logs and records kept in $work"
}
trap cleanup EXIT

echo "==> building mock upstream and load generator"
(cd "$here" && GOWORK=off go build -o "$work/" ./mockupstream ./loadgen)

echo "==> starting mock upstream on $MOCK_ADDR"
"$work/mockupstream" -addr "$MOCK_ADDR" >"$work/mock.log" 2>&1 &
pids+=($!)

sed "s#http://127.0.0.1:18080#http://${MOCK_ADDR}#" "$here/gateway/config.json" >"$work/config.json"
echo "==> starting Bifrost on :$PORT (app dir $work)"
(cd "$work" && exec "$BIFROST_BIN" -app-dir . -port "$PORT" -host 127.0.0.1 >"$work/gateway.log" 2>&1) &
pids+=($!)
for _ in $(seq 1 60); do
  curl -sf "$GATEWAY/health" >/dev/null && break
  sleep 1
done
curl -sf "$GATEWAY/health" >/dev/null || { echo "gateway did not become healthy"; tail -30 "$work/gateway.log"; exit 1; }

echo "==> replaying traffic"
"$work/loadgen" -gateway "$GATEWAY" -n "$REQUESTS" -c "$CONCURRENCY"

echo
echo "==> canary rule for $CANDIDATE at $(awk "BEGIN{print $WEIGHT*100}")%"
q="experiment=$(printf %s "$EXPERIMENT" | sed 's/ /%20/g')&candidate=${CANDIDATE}&weight=${WEIGHT}"
rule="$(curl -sf "$GATEWAY/api/shadow/canary-rule?$q")"
echo "$rule"

echo
echo "==> promoting: POST /api/governance/routing-rules"
status="$(curl -s -o "$work/rule-response.json" -w '%{http_code}' -X POST "$GATEWAY/api/governance/routing-rules" \
  -H 'Content-Type: application/json' -d "$rule")"
echo "HTTP $status: $(cat "$work/rule-response.json")"
if [ "$status" -ge 300 ]; then
  echo "routing rule was not created (the routing-rules API needs the config store and governance plugin)"
  exit 1
fi

echo
echo "==> verifying the canary: 200 requests, counting which model served them"
mini=0
for _ in $(seq 1 200); do
  served="$(curl -s -D - -o /dev/null "$GATEWAY/v1/chat/completions" -H 'Content-Type: application/json' \
    -H 'x-bf-shadow: off' \
    -d '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"What is the capital of Italy? Answer briefly."}]}' |
    tr -d '\r' | awk -F': ' 'tolower($1)=="x-bifrost-routing-info-model"{print $2}')"
  [ "$served" = "gpt-4o-mini" ] && mini=$((mini + 1))
done
echo "gpt-4o-mini served $mini of 200 requests (target $(awk "BEGIN{print $WEIGHT*200}"))"
