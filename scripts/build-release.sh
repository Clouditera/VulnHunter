#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}" 
OUT="${OUT:-$ROOT/release/vulnhunt-release-$VERSION}"
MINIO_IMAGE="${MINIO_IMAGE:-minio/minio:RELEASE.2025-09-07T16-13-09Z}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
YOUNGFLOW_VERSION="${YOUNGFLOW_VERSION:-0.2.5}"

rm -rf "$OUT"
mkdir -p "$OUT/images" "$OUT/docs"

cat > VERSION.json << JSON
{
  "product": "vulnhunt",
  "version": "$VERSION",
  "buildTime": "$BUILD_TIME",
  "gitCommit": "$GIT_COMMIT",
  "youngflowVersion": "$YOUNGFLOW_VERSION",
  "licenseSchema": "v1",
  "images": {
    "service": "vulnhunt-service:$VERSION",
    "web": "vulnhunt-web:$VERSION",
    "worker": "vulnhunt-worker:$VERSION",
    "evalWorker": "vulnhunt-eval-worker:$VERSION",
    "postgres": "$POSTGRES_IMAGE",
    "minio": "$MINIO_IMAGE"
  }
}
JSON

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

docker save "vulnhunt-service:$VERSION" -o "$OUT/images/vulnhunt-service.tar"
docker save "vulnhunt-web:$VERSION" -o "$OUT/images/vulnhunt-web.tar"
docker save "vulnhunt-worker:$VERSION" -o "$OUT/images/vulnhunt-worker.tar"
docker save "vulnhunt-eval-worker:$VERSION" -o "$OUT/images/vulnhunt-eval-worker.tar"
docker save "$POSTGRES_IMAGE" -o "$OUT/images/postgres-16-alpine.tar"
docker save "$MINIO_IMAGE" -o "$OUT/images/minio.tar"

cp VERSION.json "$OUT/VERSION.json"
cp deploy/docker-compose.yml deploy/.env.example deploy/install.sh deploy/upgrade.sh deploy/uninstall.sh deploy/doctor.sh "$OUT/"
sed -i "s|^SERVICE_IMAGE=.*|SERVICE_IMAGE=vulnhunt-service:$VERSION|" "$OUT/.env.example"
sed -i "s|^WEB_IMAGE=.*|WEB_IMAGE=vulnhunt-web:$VERSION|" "$OUT/.env.example"
sed -i "s|^WORKER_IMAGE=.*|WORKER_IMAGE=vulnhunt-worker:$VERSION|" "$OUT/.env.example"
sed -i "s|^EVAL_WORKER_IMAGE=.*|EVAL_WORKER_IMAGE=vulnhunt-eval-worker:$VERSION|" "$OUT/.env.example"
cp -r docs/vulnhunt-srv/releases "$OUT/docs/releases" 2>/dev/null || true
cp deploy/README.md "$OUT/docs/install.md" 2>/dev/null || true
chmod +x "$OUT"/*.sh

tar -C "$(dirname "$OUT")" -czf "$OUT.tar.gz" "$(basename "$OUT")"
echo "release package: $OUT.tar.gz"
