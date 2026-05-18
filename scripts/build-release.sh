#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}" 
OUT="${OUT:-$ROOT/release/vulnhunt-release-$VERSION}"
MINIO_IMAGE="${MINIO_IMAGE:-minio/minio:RELEASE.2025-09-07T16-13-09Z}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"

rm -rf "$OUT"
mkdir -p "$OUT/images" "$OUT/docs"

pnpm build
pnpm --filter @vulnhunt/worker-bridge build
if [[ ! -x submodules/youngflow/release/youngflow-linux-x64 ]]; then
  echo "missing submodules/youngflow/release/youngflow-linux-x64" >&2
  exit 1
fi

docker build -f deploy/dockerfiles/service.Dockerfile -t "vulnhunt-service:$VERSION" -t vulnhunt-service:latest .
docker build -f deploy/dockerfiles/web.Dockerfile -t "vulnhunt-web:$VERSION" -t vulnhunt-web:latest .
docker build -f deploy/dockerfiles/worker.Dockerfile -t "vulnhunt-worker:$VERSION" -t vulnhunt-worker:latest .
docker build -f deploy/dockerfiles/eval-worker.Dockerfile -t "vulnhunt-eval-worker:$VERSION" -t vulnhunt-eval-worker:latest .
docker pull "$POSTGRES_IMAGE"
docker pull "$MINIO_IMAGE"

docker save vulnhunt-service:latest -o "$OUT/images/vulnhunt-service.tar"
docker save vulnhunt-web:latest -o "$OUT/images/vulnhunt-web.tar"
docker save vulnhunt-worker:latest -o "$OUT/images/vulnhunt-worker.tar"
docker save vulnhunt-eval-worker:latest -o "$OUT/images/vulnhunt-eval-worker.tar"
docker save "$POSTGRES_IMAGE" -o "$OUT/images/postgres-16-alpine.tar"
docker save "$MINIO_IMAGE" -o "$OUT/images/minio.tar"

cp deploy/docker-compose.yml deploy/.env.example deploy/install.sh deploy/upgrade.sh deploy/uninstall.sh deploy/doctor.sh "$OUT/"
cp -r docs/vulnhunt-srv/releases "$OUT/docs/releases" 2>/dev/null || true
cp deploy/README.md "$OUT/docs/install.md" 2>/dev/null || true
chmod +x "$OUT"/*.sh

tar -C "$(dirname "$OUT")" -czf "$OUT.tar.gz" "$(basename "$OUT")"
echo "release package: $OUT.tar.gz"
