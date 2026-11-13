#!/usr/bin/env bash
# Starts the hosted demo: mock upstream and gateway on loopback, the front door
# on $PORT, then seeds the scorecards so every candidate has a verdict within a
# minute of boot. If any process exits, the container exits and the platform
# restarts it with a fresh demo.
set -euo pipefail

PORT="${PORT:-10000}"
SEED="${SEED:-300}"
WORK_DIR="${WORK_DIR:-/tmp/relayproof}"
export BIFROST_SETUP_TOKEN="${BIFROST_SETUP_TOKEN:?set BIFROST_SETUP_TOKEN to a random secret}"
gateway="http://127.0.0.1:8080"

mkdir -p "$WORK_DIR"
cp /etc/relayproof/config.json "$WORK_DIR/config.json"

mockupstream -addr 127.0.0.1:18080 &
(cd "$WORK_DIR" && exec bifrost-http -app-dir . -port 8080 -host 127.0.0.1) &
frontdoor -addr ":$PORT" -gateway "$gateway" -mock http://127.0.0.1:18080 &

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

if [ "$SEED" -gt 0 ]; then
  loadgen -gateway "$gateway" -n "$SEED" -c 16 -wait 120s | tail -12 || echo "relayproof-demo: seeding failed" >&2
fi

wait -n
echo "relayproof-demo: a demo process exited; stopping so the container restarts" >&2
exit 1
