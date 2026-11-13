#!/usr/bin/env bash
# Starts the hosted demo. Two modes:
#
#   claude  (ANTHROPIC_API_KEY is set): the gateway serves real Claude models.
#           claude-opus-5-5 answers; claude-sonnet-5-5 and claude-haiku-5-5 are
#           shadowed and judged by claude-opus-5-5. A fault proxy sits in front
#           of api.anthropic.com so visitors can simulate an outage. Spend is
#           capped: DAILY_REQUESTS requests a UTC day (default 400), live traffic
#           only while someone has the console open, and the plugin's own
#           daily budget for shadow and judge calls.
#   mock    (no key, or DEMO_MODE=mock): the deterministic mock upstream plays
#           every model, no keys and no spend.
#
# The mock upstream, gateway and fault proxy listen on loopback; the front door
# on $PORT is the only public listener. If any process exits, the container
# exits and the platform restarts it.
set -euo pipefail

PORT="${PORT:-10000}"
WORK_DIR="${WORK_DIR:-/tmp/relayproof}"
export BIFROST_SETUP_TOKEN="${BIFROST_SETUP_TOKEN:?set BIFROST_SETUP_TOKEN to a random secret}"
gateway="http://127.0.0.1:8080"

mode="${DEMO_MODE:-auto}"
if [ "$mode" = "auto" ]; then
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then mode=claude; else mode=mock; fi
fi

mkdir -p "$WORK_DIR"
pids=()
if [ "$mode" = "claude" ]; then
  : "${ANTHROPIC_API_KEY:?DEMO_MODE=claude needs ANTHROPIC_API_KEY}"
  cp /etc/relayproof/claude.json "$WORK_DIR/config.json"
  # Front door settings for a paid provider, unless set explicitly.
  export UPSTREAM="${UPSTREAM:-anthropic}"
  export INCIDENT_MODELS="${INCIDENT_MODELS:-claude-sonnet-5-5,claude-haiku-5-5}"
  export MAX_TOKENS="${MAX_TOKENS:-1024}"
  export REASONING_EFFORT="${REASONING_EFFORT:-low}"
  export STREAM_PCT="${STREAM_PCT:-0}"
  export DAILY_REQUESTS="${DAILY_REQUESTS:-400}"
  export WATCHED_FOR="${WATCHED_FOR:-3m}"
  export TRAFFIC_EVERY="${TRAFFIC_EVERY:-15s}"
  export SEED="${SEED:-40}"
  primary="anthropic/claude-opus-5-5"
  admin="http://127.0.0.1:18081"
  burst_max=30
  # Local testing can point the proxy at the mock's Anthropic face.
  if [ -n "${ANTHROPIC_UPSTREAM:-}" ] && [ "${START_MOCK:-0}" = "1" ]; then
    mockupstream -addr 127.0.0.1:18080 &
    pids+=($!)
  fi
  faultproxy -addr 127.0.0.1:18081 -upstream "${ANTHROPIC_UPSTREAM:-https://api.anthropic.com}" &
  pids+=($!)
else
  cp /etc/relayproof/config.json "$WORK_DIR/config.json"
  export UPSTREAM="${UPSTREAM:-mock}"
  export SEED="${SEED:-300}"
  primary="openai/gpt-4o"
  admin="http://127.0.0.1:18080"
  burst_max=60
  mockupstream -addr 127.0.0.1:18080 &
  pids+=($!)
fi
echo "relayproof-demo: mode $mode"

(cd "$WORK_DIR" && exec bifrost-http -app-dir . -port 8080 -host 127.0.0.1) &
pids+=($!)
seed_flag=()
if [ "$mode" = "claude" ]; then seed_flag=(-seed "$SEED"); fi
frontdoor -addr ":$PORT" -gateway "$gateway" -mock "$admin" -model "$primary" -burst-max "$burst_max" ${seed_flag[@]+"${seed_flag[@]}"} &
pids+=($!)

# Bifrost runs its store migrations and loads the model catalog on boot; on a
# small instance that takes a few minutes.
for _ in $(seq 1 "${BOOT_TIMEOUT:-300}"); do
  curl -sf "$gateway/health" >/dev/null && break
  sleep 1
done
if ! curl -sf "$gateway/health" >/dev/null; then
  echo "relayproof-demo: gateway did not become healthy" >&2
  exit 1
fi
echo "relayproof-demo: gateway healthy, front door on :$PORT"

# In mock mode the load generator seeds the scorecards; in claude mode the
# front door does, counted against the daily cap.
if [ "$mode" = "mock" ] && [ "$SEED" -gt 0 ]; then
  loadgen -gateway "$gateway" -n "$SEED" -c 16 -wait 120s | tail -12 || echo "relayproof-demo: seeding failed" >&2
fi

wait -n "${pids[@]}"
echo "relayproof-demo: a demo process exited; stopping so the container restarts" >&2
exit 1
