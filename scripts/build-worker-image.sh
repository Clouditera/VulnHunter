#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE_TAG="${1:-vulnhunter-worker:local}"
if [[ $# -gt 0 ]]; then shift; fi

VULNFORGE_VERSION="${VULNFORGE_VERSION:-$(cat flows/vulnforge/FLOW_VERSION)}"
VULNFORGE_COMMIT="${VULNFORGE_COMMIT:-$(git rev-parse HEAD)}"
PI_VERSION="${PI_VERSION:-$(sed -n 's/.*PI_VERSION = "\([^"]*\)".*/\1/p' "$ROOT/packages/shared/src/pi.version.ts" | head -1)}"

# A clean checkout does not contain generated YoungFlow/worker-bridge outputs.
# Build both exclusively from committed sources before Docker reads its context.
git submodule update --init --recursive submodules/youngflow flows/vulnforge/extensions/pi-web-access

# Freshness skip (task-d3934c0e): an unconditional rebuild rewrites the binary
# even when nothing changed, and the fresh mtime invalidates the Docker COPY
# layer — every run rebuilt the whole tail of the worker image. If the binary
# exists and no submodule source (excluding node_modules/.git/release/dist) is
# newer, reuse it; a pin bump or source edit rebuilds automatically.
BIN=submodules/youngflow/release/youngflow-linux-x64
if [ -x "$BIN" ] && ! find submodules/youngflow \
    -path '*/node_modules' -prune -o -path '*/.git' -prune -o \
    -path '*/release' -prune -o -path '*/dist' -prune -o \
    -type f -newer "$BIN" -print -quit | grep -q .; then
  echo "[worker-build] youngflow binary up-to-date — skipping rebuild"
else
  (
    cd submodules/youngflow
    npm ci --no-audit --no-fund
    PKG_TARGETS=node20-linux-x64 npm run build:binary
  )
fi

test -x submodules/youngflow/release/youngflow-linux-x64 || {
  echo "worker build failed: YoungFlow linux binary was not generated" >&2
  exit 1
}

corepack pnpm install --frozen-lockfile
corepack pnpm --filter @vulnhunter/worker-bridge build
test -s packages/worker-bridge/dist/bundle.js || {
  echo "worker build failed: worker-bridge bundle was not generated" >&2
  exit 1
}

docker build "$@" \
  -f deploy/dockerfiles/worker.Dockerfile \
  --build-arg VULNFORGE_VERSION="$VULNFORGE_VERSION" \
  --build-arg VULNFORGE_COMMIT="$VULNFORGE_COMMIT" \
  --build-arg PI_VERSION="$PI_VERSION" \
  -t "$IMAGE_TAG" \
  .

echo "worker image: $IMAGE_TAG"
