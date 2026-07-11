#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}" 
OUT="${OUT:-$ROOT/release/vulnagent-release-$VERSION}"
MINIO_IMAGE="${MINIO_IMAGE:-minio/minio:RELEASE.2025-09-07T16-13-09Z}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
YOUNGFLOW_VERSION="${YOUNGFLOW_VERSION:-0.3.8}"
VULNFORGE_VERSION="${VULNFORGE_VERSION:-2.0}"
VULNFORGE_COMMIT="${VULNFORGE_COMMIT:-058da50be533b4605ff2e1614cef77b5c2d936bd}"

git submodule update --init --recursive
ACTUAL_VULNFORGE_COMMIT="$(git -C flows/vulnforge rev-parse HEAD)"
if [[ "$ACTUAL_VULNFORGE_COMMIT" != "$VULNFORGE_COMMIT" ]]; then
  echo "VulnForge baseline mismatch: expected $VULNFORGE_COMMIT, got $ACTUAL_VULNFORGE_COMMIT" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT/images" "$OUT/docs" "$OUT/.secrets"

cat > "$OUT/VERSION.json" << JSON
{
  "product": "vulnagent",
  "version": "$VERSION",
  "buildTime": "$BUILD_TIME",
  "gitCommit": "$GIT_COMMIT",
  "youngflowVersion": "$YOUNGFLOW_VERSION",
  "vulnforgeVersion": "$VULNFORGE_VERSION",
  "vulnforgeCommit": "$VULNFORGE_COMMIT",
  "licenseSchema": "v1",
  "images": {
    "service": "vulnagent-service:$VERSION",
    "web": "vulnagent-web:$VERSION",
    "worker": "vulnagent-worker:$VERSION",
    "evalWorker": "vulnagent-eval-worker:$VERSION",
    "postgres": "$POSTGRES_IMAGE",
    "minio": "$MINIO_IMAGE"
  }
}
JSON

pnpm turbo run build --filter=@vulnagent/service --filter=@vulnagent/web
pnpm --filter @vulnagent/worker-bridge build
if [[ ! -f flows/vulnforge/flow.audit.yaml ]]; then
  echo "missing flows/vulnforge/flow.audit.yaml; run git submodule update --init --recursive" >&2
  exit 1
fi
if [[ ! -f flows/vulnforge/extensions/output-contract/package.json ]]; then
  echo "missing flows/vulnforge/extensions/output-contract/package.json; run git submodule update --init --recursive" >&2
  exit 1
fi
if [[ ! -x submodules/youngflow/release/youngflow-linux-x64 ]]; then
  echo "missing submodules/youngflow/release/youngflow-linux-x64; run git submodule update --init --recursive" >&2
  exit 1
fi

docker build -f deploy/dockerfiles/service.Dockerfile \
  --build-arg VULNAGENT_VERSION="$VERSION" \
  --build-arg VULNAGENT_BUILD_TIME="$BUILD_TIME" \
  --build-arg VULNAGENT_GIT_COMMIT="$GIT_COMMIT" \
  --build-arg YOUNGFLOW_VERSION="$YOUNGFLOW_VERSION" \
  -t "vulnagent-service:$VERSION" -t vulnagent-service:latest .
docker build -f deploy/dockerfiles/web.Dockerfile -t "vulnagent-web:$VERSION" -t vulnagent-web:latest .
docker build -f deploy/dockerfiles/worker.Dockerfile \
  --build-arg VULNFORGE_VERSION="$VULNFORGE_VERSION" \
  --build-arg VULNFORGE_COMMIT="$VULNFORGE_COMMIT" \
  -t "vulnagent-worker:$VERSION" -t vulnagent-worker:latest .
docker build -f deploy/dockerfiles/eval-worker.Dockerfile -t "vulnagent-eval-worker:$VERSION" -t vulnagent-eval-worker:latest .
docker pull "$POSTGRES_IMAGE"
docker pull "$MINIO_IMAGE"

validate_no_runtime_sourcemaps() {
  local image="$1" paths="$2"
  docker run --rm "$image" sh -lc "
    if find $paths -type f \\( -name '*.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \\) | grep -q .; then
      echo 'release validation failed: map/declaration files found in $image' >&2
      find $paths -type f \\( -name '*.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \\) | head -20 >&2
      exit 1
    fi
    if grep -RIl 'sourceMappingURL' $paths 2>/dev/null | grep -q .; then
      echo 'release validation failed: sourceMappingURL references found in $image' >&2
      grep -RIl 'sourceMappingURL' $paths 2>/dev/null | head -20 >&2
      exit 1
    fi
  "
}
validate_no_runtime_sourcemaps "vulnagent-service:$VERSION" "/app/packages /app/public"
validate_no_runtime_sourcemaps "vulnagent-web:$VERSION" "/usr/share/nginx/html"

docker save "vulnagent-service:$VERSION" -o "$OUT/images/vulnagent-service.tar"
docker save "vulnagent-web:$VERSION" -o "$OUT/images/vulnagent-web.tar"
docker save "vulnagent-worker:$VERSION" -o "$OUT/images/vulnagent-worker.tar"
docker save "vulnagent-eval-worker:$VERSION" -o "$OUT/images/vulnagent-eval-worker.tar"
docker save "$POSTGRES_IMAGE" -o "$OUT/images/postgres-16-alpine.tar"
docker save "$MINIO_IMAGE" -o "$OUT/images/minio.tar"

cp deploy/docker-compose.yml deploy/.env.example deploy/install.sh deploy/upgrade.sh deploy/uninstall.sh deploy/doctor.sh "$OUT/"
LICENSE_PUBLIC_KEY_SOURCE="${LICENSE_PUBLIC_KEY_FILE:-$HOME/.vulnhunt-issuer/license-public.pem}"
if [[ ! -f "$LICENSE_PUBLIC_KEY_SOURCE" ]]; then
  echo "missing license public key: $LICENSE_PUBLIC_KEY_SOURCE" >&2
  echo "Set LICENSE_PUBLIC_KEY_FILE to the issuer public key PEM before building an enterprise release." >&2
  exit 1
fi
cp "$LICENSE_PUBLIC_KEY_SOURCE" "$OUT/.secrets/license-public.pem"
sed -i "s|^SERVICE_IMAGE=.*|SERVICE_IMAGE=vulnagent-service:$VERSION|" "$OUT/.env.example"
sed -i "s|^WEB_IMAGE=.*|WEB_IMAGE=vulnagent-web:$VERSION|" "$OUT/.env.example"
sed -i "s|^WORKER_IMAGE=.*|WORKER_IMAGE=vulnagent-worker:$VERSION|" "$OUT/.env.example"
sed -i "s|^EVAL_WORKER_IMAGE=.*|EVAL_WORKER_IMAGE=vulnagent-eval-worker:$VERSION|" "$OUT/.env.example"
if grep -q "^EDITION=" "$OUT/.env.example"; then
  sed -i "s|^EDITION=.*|EDITION=enterprise|" "$OUT/.env.example"
else
  printf '\nEDITION=enterprise\n' >> "$OUT/.env.example"
fi

# Enterprise release guardrails. Official customer/offline packages must boot with
# license routes/UI enabled and must never ship private issuer material.
grep -qx "EDITION=enterprise" "$OUT/.env.example" || { echo "release validation failed: .env.example must set EDITION=enterprise" >&2; exit 1; }
[[ -s "$OUT/.secrets/license-public.pem" ]] || { echo "release validation failed: missing .secrets/license-public.pem" >&2; exit 1; }
grep -q "VULNAGENT_LICENSE_PUBLIC_KEY_FILE:.*run/secrets/license-public.pem" "$OUT/docker-compose.yml" || { echo "release validation failed: compose missing VULNAGENT_LICENSE_PUBLIC_KEY_FILE" >&2; exit 1; }
grep -q "LICENSE_PUBLIC_KEY_FILE.*run/secrets/license-public.pem:ro" "$OUT/docker-compose.yml" || { echo "release validation failed: compose missing license public key mount" >&2; exit 1; }
if find "$OUT" -type f ! -path "$OUT/images/*" ! -path "$OUT/.secrets/license-public.pem" -print0 | xargs -0 grep -Il "BEGIN .*PRIVATE KEY" | grep -q .; then
  echo "release validation failed: private key material detected in release files" >&2
  exit 1
fi
cp -r docs/vulnagent-srv/releases/. "$OUT/docs/"
cp deploy/README.md "$OUT/docs/install.md" 2>/dev/null || true
chmod +x "$OUT"/*.sh
if find "$OUT" -type f ! -path "$OUT/images/*" \( -name "*.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) | grep -q .; then
  echo "release validation failed: map/declaration files found in release files" >&2
  find "$OUT" -type f ! -path "$OUT/images/*" \( -name "*.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) | head -20 >&2
  exit 1
fi
if find "$OUT" -type f ! -path "$OUT/images/*" ! -path "$OUT/.secrets/license-public.pem" -print0 | xargs -0 grep -Il "sourceMappingURL" | grep -q .; then
  echo "release validation failed: sourceMappingURL found in release files" >&2
  exit 1
fi

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
