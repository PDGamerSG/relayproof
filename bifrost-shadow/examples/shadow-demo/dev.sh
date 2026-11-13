#!/usr/bin/env bash
# A long-running local backend for frontend work: mock upstream + Bifrost
# gateway with the shadow plugin, seeded with traffic so every scorecard has a
# verdict, then (by default) a slow stream of live requests so counters, canary
# health and the rollout log keep moving. Stop it with Ctrl-C.
#
#   BIFROST_BIN=/path/to/bifrost-http ./dev.sh
#   BIFROST_BIN=... PORT=8080 SEED=300 TRAFFIC_EVERY=1 ./dev.sh
#
# Prints the gateway URL and the setup token the frontend sends as
# X-Bifrost-Setup-Token. No API keys are needed.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
MOCK_ADDR="${MOCK_ADDR:-127.0.0.1:18080}"
SEED="${SEED:-300}"
TRAFFIC_EVERY="${TRAFFIC_EVERY:-1}" # seconds between background requests; 0 turns it off
BIFROST_BIN="${BIFROST_BIN:?set BIFROST_BIN to a bifrost-http binary built with the shadow plugin}"
GATEWAY="http://localhost:${PORT}"
export BIFROST_SETUP_TOKEN="${BIFROST_SETUP_TOKEN:-shadow-dev-token}"

work="${WORK_DIR:-$(mktemp -d)}"
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  echo
  echo "stopped; gateway data kept in $work"
}
trap cleanup EXIT INT TERM

echo "==> building mock upstream and load generator"
(cd "$here" && GOWORK=off go build -o "$work/" ./mockupstream ./loadgen)

"$work/mockupstream" -addr "$MOCK_ADDR" >"$work/mock.log" 2>&1 &
pids+=($!)
sed "s#http://127.0.0.1:18080#http://${MOCK_ADDR}#" "$here/gateway/config.json" >"$work/config.json"
(cd "$work" && exec "$BIFROST_BIN" -app-dir . -port "$PORT" -host 127.0.0.1 >"$work/gateway.log" 2>&1) &
pids+=($!)
for _ in $(seq 1 60); do
  curl -sf "$GATEWAY/health" >/dev/null && break
  sleep 1
done
curl -sf "$GATEWAY/health" >/dev/null || { echo "gateway did not become healthy"; tail -30 "$work/gateway.log"; exit 1; }

if [ "$SEED" -gt 0 ]; then
  echo "==> seeding $SEED requests"
  "$work/loadgen" -gateway "$GATEWAY" -n "$SEED" -c 16 | tail -8
fi

if [ "$TRAFFIC_EVERY" != "0" ]; then
  # Live traffic with a few different prompts, half of it sampled.
  (
    prompts=("What is the capital of Italy? Answer briefly." "What is 17 * 23?" "What is the capital of Japan? Answer briefly.")
    i=0
    while true; do
      p="${prompts[$((i % ${#prompts[@]}))]}"
      curl -s -o /dev/null "$GATEWAY/v1/chat/completions" -H 'Content-Type: application/json' \
        -d "{\"model\":\"openai/gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"$p\"}]}" || true
      i=$((i + 1))
      sleep "$TRAFFIC_EVERY"
    done
  ) &
  pids+=($!)
fi

cat <<EOF

Backend ready.

  Gateway         $GATEWAY
  Shadow API      $GATEWAY/api/shadow/summary
  Setup token     $BIFROST_SETUP_TOKEN   (header X-Bifrost-Setup-Token)
  Mock upstream   http://$MOCK_ADDR
  Logs            $work/gateway.log

  curl -H 'X-Bifrost-Setup-Token: $BIFROST_SETUP_TOKEN' $GATEWAY/api/shadow/summary

Simulate a provider incident for a canary (the guard rolls it back):
  curl -X POST 'http://$MOCK_ADDR/admin/incident?model=gpt-4o-mini&error_pct=60'
  curl -X POST 'http://$MOCK_ADDR/admin/incident?model=gpt-4o-mini&error_pct=0'

Background traffic: one request every ${TRAFFIC_EVERY}s (TRAFFIC_EVERY=0 to stop). Ctrl-C to quit.
EOF
wait
