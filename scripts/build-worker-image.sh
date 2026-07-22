#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGE_TAG="${1:-vulnhunter-worker:local}"
if [[ $# -gt 0 ]]; then shift; fi

VULNFORGE_VERSION="${VULNFORGE_VERSION:-2.0-5-g1782ef6}"
VULNFORGE_COMMIT="${VULNFORGE_COMMIT:-1782ef6d99db58fda74c8e1524b9237ca39cad2c}"

# A clean checkout does not contain generated YoungFlow/worker-bridge outputs.
# Build both exclusively from committed sources before Docker reads its context.
git submodule update --init --recursive submodules/youngflow flows/vulnforge

actual_vulnforge_commit="$(git -C flows/vulnforge rev-parse HEAD)"
if [[ "$actual_vulnforge_commit" != "$VULNFORGE_COMMIT" ]]; then
  echo "worker build failed: VulnForge baseline mismatch (expected $VULNFORGE_COMMIT, got $actual_vulnforge_commit)" >&2
  exit 1
fi

(
  cd submodules/youngflow
  npm ci --no-audit --no-fund
  PKG_TARGETS=node20-linux-x64 npm run build:binary
)

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
  -t "$IMAGE_TAG" \
  .

echo "worker image: $IMAGE_TAG"
