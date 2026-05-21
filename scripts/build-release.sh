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

cat > "$OUT/VERSION.json" << JSON
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

pnpm turbo run build --filter=@vulnhunt/service --filter=@vulnhunt/web
pnpm --filter @vulnhunt/worker-bridge build
if [[ ! -f flows/vulnhunt/flow.yaml ]]; then
  echo "missing flows/vulnhunt/flow.yaml; run git submodule update --init --recursive" >&2
  exit 1
fi
if [[ ! -x submodules/youngflow/release/youngflow-linux-x64 ]]; then
  echo "missing submodules/youngflow/release/youngflow-linux-x64; run git submodule update --init --recursive" >&2
  exit 1
fi

docker build -f deploy/dockerfiles/service.Dockerfile \
  --build-arg VULNHUNT_VERSION="$VERSION" \
  --build-arg VULNHUNT_BUILD_TIME="$BUILD_TIME" \
  --build-arg VULNHUNT_GIT_COMMIT="$GIT_COMMIT" \
  --build-arg YOUNGFLOW_VERSION="$YOUNGFLOW_VERSION" \
  -t "vulnhunt-service:$VERSION" -t vulnhunt-service:latest .
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

cp deploy/docker-compose.yml deploy/.env.example deploy/install.sh deploy/upgrade.sh deploy/uninstall.sh deploy/doctor.sh "$OUT/"
mkdir -p "$OUT/.secrets"
cp deploy/license-public.pem "$OUT/.secrets/license-public.pem"
sed -i "s|^SERVICE_IMAGE=.*|SERVICE_IMAGE=vulnhunt-service:$VERSION|" "$OUT/.env.example"
sed -i "s|^WEB_IMAGE=.*|WEB_IMAGE=vulnhunt-web:$VERSION|" "$OUT/.env.example"
sed -i "s|^WORKER_IMAGE=.*|WORKER_IMAGE=vulnhunt-worker:$VERSION|" "$OUT/.env.example"
sed -i "s|^EVAL_WORKER_IMAGE=.*|EVAL_WORKER_IMAGE=vulnhunt-eval-worker:$VERSION|" "$OUT/.env.example"
cp -r docs/vulnhunt-srv/releases/. "$OUT/docs/"
cp deploy/README.md "$OUT/docs/install.md" 2>/dev/null || true
chmod +x "$OUT"/*.sh

(
  cd "$OUT"
  find images -type f -name '*.tar' -print | sort
  printf '%s\n' docker-compose.yml .env.example install.sh doctor.sh upgrade.sh uninstall.sh VERSION.json .secrets/license-public.pem
  find docs -type f -print | sort
) | while IFS= read -r file; do
  [[ -f "$OUT/$file" ]] && sha256sum "$OUT/$file"
done | sed "s|  $OUT/|  |" > "$OUT/checksums.sha256"

tar -C "$(dirname "$OUT")" -czf "$OUT.tar.gz" "$(basename "$OUT")"
(
  cd "$(dirname "$OUT")"
  sha256sum "$(basename "$OUT").tar.gz"
) > "$OUT.tar.gz.sha256"
echo "release package: $OUT.tar.gz"
echo "release checksum: $OUT.tar.gz.sha256"
