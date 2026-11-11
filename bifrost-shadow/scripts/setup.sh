#!/usr/bin/env bash
# Builds a Bifrost gateway with the shadow traffic plugin on top of upstream
# maximhq/bifrost, pinned to the commit the patches were made against.
#
#   bifrost-shadow/scripts/setup.sh [target-dir]
#
# target-dir   where to clone Bifrost (default: ../bifrost next to bifrost-shadow)
# SKIP_UI=1    skip the dashboard build and embed a placeholder page instead
# BIFROST_REF  upstream commit to build on (default: the pinned one below)
#
# Needs git, Go 1.27+, a C compiler (the SQLite config store uses cgo), and
# unless SKIP_UI=1, Node with npm at the version in ui/.nvmrc (26 at the pinned
# commit). Re-running is safe: patches that are already applied are skipped.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-$here/../bifrost}"
ref="${BIFROST_REF:-ed62e4bd15e88a2c33ea2592e3fa434255fc04bf}"

step() { printf '\n==> %s\n' "$*"; }

step "Bifrost source at $target (commit ${ref:0:7})"
if [ ! -d "$target/.git" ]; then
  # Blobless clone: full history for checkout and apply, file contents fetched on demand.
  git clone --quiet --filter=blob:none https://github.com/maximhq/bifrost.git "$target"
fi
target="$(cd "$target" && pwd)"
cd "$target"
if ! git cat-file -e "$ref^{commit}" 2>/dev/null; then
  git fetch --quiet origin "$ref"
fi
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "$ref^{commit}")" ]; then
  git checkout --quiet -B shadow-traffic "$ref"
fi

step "Adding the shadow plugin, gateway handler, demo, docs and dashboard page"
for dir in plugins transports examples docs ui; do
  if [ -d "$here/$dir" ]; then
    cp -R "$here/$dir/." "$target/$dir/"
  fi
done

step "Applying patches"
for patch in "$here"/patches/*.patch; do
  name="$(basename "$patch")"
  if git apply --reverse --check "$patch" 2>/dev/null; then
    echo "  $name (already applied)"
  else
    git apply --whitespace=nowarn "$patch"
    echo "  $name"
  fi
done

step "Writing go.work"
# Same module set as 'make setup-workspace', without 'go work sync', which
# rewrites unrelated go.mod files.
rm -f go.work go.work.sum
go work init ./cli ./core ./framework ./transports
for module in ./plugins/*/ ./tests/cmd/*/; do
  if [ -f "$module/go.mod" ]; then
    go work use "$module"
  fi
done

if [ "${SKIP_UI:-0}" = "1" ]; then
  step "Skipping the dashboard build (SKIP_UI=1)"
  mkdir -p transports/bifrost-http/ui
  if [ ! -f transports/bifrost-http/ui/index.html ]; then
    echo '<!doctype html><title>Bifrost</title><p>Dashboard not built (SKIP_UI=1).</p>' >transports/bifrost-http/ui/index.html
  fi
else
  step "Building the dashboard"
  (cd ui && npm ci --no-audit --no-fund && npm run build)
fi

step "Testing the shadow plugin and its HTTP handler"
(cd plugins/shadow && go test ./...)
(cd transports && go test -run 'Shadow' ./bifrost-http/handlers/ ./bifrost-http/lib/)

step "Building the gateway"
mkdir -p tmp
(cd transports && CGO_ENABLED=1 go build -o "$target/tmp/bifrost-http" ./bifrost-http)

cat <<EOF

Done. Gateway binary: $target/tmp/bifrost-http

Run the key-free demo:
  BIFROST_BIN=$target/tmp/bifrost-http $target/examples/shadow-demo/run.sh

Or start the gateway with your own config.json (see docs/features/shadow-traffic.mdx):
  $target/tmp/bifrost-http -app-dir <dir-with-config.json>
EOF
