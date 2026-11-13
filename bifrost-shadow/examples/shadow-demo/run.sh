#!/usr/bin/env bash
# End-to-end shadow traffic demo: mock upstream -> Bifrost gateway (shadow plugin)
# -> load generator -> scorecard -> gated promotion to a canary -> live canary
# health -> simulated provider incident -> automatic rollback.
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
WEAK="openai/llama-3.1-8b"
# With a config store and no dashboard login configured, Bifrost locks /api behind a
# setup token. The demo makes a throwaway one; loadgen reads it from the environment.
export BIFROST_SETUP_TOKEN="${BIFROST_SETUP_TOKEN:-shadow-demo-$(date +%s)-$RANDOM}"
api() { curl -s -H "X-Bifrost-Setup-Token: $BIFROST_SETUP_TOKEN" "$@"; }

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
echo "==> checking that $CANDIDATE is ready"
# Only a candidate whose agreement lower bound clears the threshold gets promoted.
if ! "$work/loadgen" -gateway "$GATEWAY" -report -require-ready "$CANDIDATE" >/dev/null; then
  echo "not promoting; collect more evidence first, for example REQUESTS=600 $0"
  exit 1
fi
echo "$CANDIDATE is ready"

json_field() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
promote() { api -o "$work/promote.json" -w '%{http_code}' -X POST "$GATEWAY/api/shadow/promote" -H 'Content-Type: application/json' -d "$1"; }

echo
echo "==> promotion is gated on the verdict: trying $WEAK"
status="$(promote "{\"experiment\":\"$EXPERIMENT\",\"candidate\":\"$WEAK\",\"weight\":$WEIGHT}")"
echo "HTTP $status: $(json_field 'd.get("verdict"), "-", d.get("verdict_reason")' <"$work/promote.json")"
if [ "$status" != "409" ]; then
  echo "expected 409: a candidate that is not ready must not be promoted without an override reason"
  exit 1
fi

echo
echo "==> dry run: what promoting $CANDIDATE at $(awk "BEGIN{print $WEIGHT*100}")% would do"
status="$(promote "{\"experiment\":\"$EXPERIMENT\",\"candidate\":\"$CANDIDATE\",\"weight\":$WEIGHT,\"dry_run\":true}")"
echo "HTTP $status: $(json_field 'd["action"], d["rule"]["name"], [(t.get("model"), t["weight"]) for t in d["rule"]["targets"]], "warnings:", d["warnings"]' <"$work/promote.json")"

echo
echo "==> promoting $CANDIDATE: POST /api/shadow/promote"
status="$(promote "{\"experiment\":\"$EXPERIMENT\",\"candidate\":\"$CANDIDATE\",\"weight\":$WEIGHT}")"
echo "HTTP $status: $(json_field 'd.get("action"), d.get("rule", {}).get("id"), d.get("evidence", {}).get("verdict_reason")' <"$work/promote.json" 2>/dev/null || cat "$work/promote.json")"
if [ "$status" -ge 300 ]; then
  echo "promotion failed (it needs the config store and the routing plugin)"
  exit 1
fi

# serve_one sends one live gpt-4o request (not mirrored) and prints the model
# that served it and the HTTP status.
serve_one() {
  local out
  out="$(curl -s -D - -o /dev/null -w 'HTTPCODE:%{http_code}' "$GATEWAY/v1/chat/completions" -H 'Content-Type: application/json' \
    -H 'x-bf-shadow: off' \
    -d '{"model":"openai/gpt-4o","messages":[{"role":"user","content":"What is the capital of Italy? Answer briefly."}]}' | tr -d '\r')"
  printf '%s %s\n' "$(printf '%s\n' "$out" | awk -F': ' 'tolower($1)=="x-bifrost-routing-info-model"{print $2}')" "${out##*HTTPCODE:}"
}
export -f serve_one
export GATEWAY

# count_served N: send N live requests, 8 at a time; print how many gpt-4o-mini
# served and how many failed.
count_served() {
  seq 1 "$1" | xargs -P 8 -I{} bash -c serve_one |
    awk '{ if ($1 == "gpt-4o-mini") m++; if ($NF >= 400) f++ } END { print m + 0, f + 0 }'
}

echo
echo "==> verifying the canary: 200 requests, counting which model served them"
read -r mini _ <<<"$(count_served 200)"
echo "gpt-4o-mini served $mini of 200 requests (expected $(awk "BEGIN{print $WEIGHT*200}"))"
# A weighted split is random per request: accept anything within 3 standard deviations.
if awk -v k="$mini" -v w="$WEIGHT" 'BEGIN { n = 200; m = n * w; sd = sqrt(n * w * (1 - w)); exit !(k >= m - 3 * sd && k <= m + 3 * sd) }'; then
  echo "canary split is consistent with a $(awk "BEGIN{print $WEIGHT*100}")% weight"
else
  echo "canary split is outside the expected range"
  exit 1
fi

echo
echo "==> live canary health: GET /api/shadow/rollouts"
api "$GATEWAY/api/shadow/rollouts" | json_field '[(c["candidate"]["model"], c["health"]["status"], c["health"]["reason"]) for c in d["canaries"]]'

echo
echo "==> simulating a provider incident: gpt-4o-mini now fails 60% of requests"
curl -s -X POST "http://${MOCK_ADDR}/admin/incident?model=gpt-4o-mini&error_pct=60" >/dev/null
read -r mini failed <<<"$(count_served 150)"
echo "during the incident: gpt-4o-mini served $mini of 150 requests, $failed failed"

echo
echo "==> waiting for the canary guard to roll back"
rolled=""
for _ in $(seq 1 30); do
  rolled="$(api "$GATEWAY/api/shadow/rollouts" | json_field 'next((e["reason"] for e in d["events"] if e["action"] == "auto_rollback"), "")')"
  [ -n "$rolled" ] && break
  sleep 1
done
if [ -z "$rolled" ]; then
  echo "the canary guard did not roll back"
  exit 1
fi
echo "rolled back: $rolled"
curl -s -X POST "http://${MOCK_ADDR}/admin/incident?model=gpt-4o-mini&error_pct=0" >/dev/null

echo
echo "==> after the rollback: 100 requests"
read -r mini failed <<<"$(count_served 100)"
echo "gpt-4o-mini served $mini of 100 requests, $failed failed"
if [ "$mini" -ne 0 ]; then
  echo "traffic still reaches the rolled-back candidate"
  exit 1
fi
echo "all traffic is back on gpt-4o"

echo
echo "==> rollout log"
api "$GATEWAY/api/shadow/rollouts" | python3 -c '
import json, sys
for e in reversed(json.load(sys.stdin)["events"]):
    print("%s  %-14s %-13s weight=%-6s by %s" % (e["at"][:19], e["action"], e["candidate"]["model"], e["weight"], e["actor"]))
'
