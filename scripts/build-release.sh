#!/usr/bin/env bash
# VulnHunter release packager (transitional monorepo + future OSS community entry).
# Prefer --edition community|enterprise|saas. Default: community on pure OSS trees;
# enterprise when packages/enterprise is present (legacy monorepo).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=release/lib.sh
source "$ROOT/scripts/release/lib.sh"

EDITION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --edition) EDITION="$2"; shift 2 ;;
    --edition=*) EDITION="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: $0 [--edition community|enterprise|saas]"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$EDITION" ]]; then
  if [[ -d "$ROOT/packages/enterprise" ]]; then
    EDITION="${EDITION_DEFAULT:-enterprise}"
  else
    EDITION=community
  fi
fi
export EDITION

case "$EDITION" in
  community|enterprise|saas) ;;
  *) release_die "invalid --edition $EDITION" ;;
esac

# Pure OSS tree (no commercial packages) cannot build enterprise/saas
if [[ "$EDITION" != "community" && ! -d "$ROOT/packages/enterprise" ]]; then
  release_die "EDITION=$EDITION requires packages/enterprise (use VulnHunter-enterprise monorepo)"
fi
if [[ "$EDITION" == "saas" && ! -d "$ROOT/packages/saas" ]]; then
  release_die "EDITION=saas requires packages/saas"
fi

VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
if [[ -n "${OUT:-}" ]]; then
  : # caller override
elif [[ "$EDITION" == "enterprise" ]]; then
  OUT="$ROOT/release/vulnhunter-release-$VERSION"
else
  OUT="$ROOT/release/vulnhunter-release-$VERSION-$EDITION"
fi

MINIO_IMAGE="${MINIO_IMAGE:-minio/minio:RELEASE.2025-09-07T16-13-09Z}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
YOUNGFLOW_VERSION="${YOUNGFLOW_VERSION:-0.3.8}"
VULNFORGE_VERSION="${VULNFORGE_VERSION:-2.0-5-g1782ef6}"
VULNFORGE_COMMIT="${VULNFORGE_COMMIT:-1782ef6d99db58fda74c8e1524b9237ca39cad2c}"
PI_VERSION="${PI_VERSION:-$(node -p "require('./packages/shared/src/pi.version')")}"

release_require_cmd docker
release_require_cmd pnpm
release_require_cmd node

release_check_vulnforge

rm -rf "$OUT"
mkdir -p "$OUT/images" "$OUT/docs" "$OUT/.secrets"

release_write_version_json "$OUT"

pnpm turbo run build --filter=@vulnhunter/service --filter=@vulnhunter/web
pnpm --filter @vulnhunter/worker-bridge build

if [[ "$EDITION" == "community" ]]; then
  SERVICE_DOCKERFILE=deploy/dockerfiles/service.community.Dockerfile
  [[ -f "$SERVICE_DOCKERFILE" ]] || SERVICE_DOCKERFILE=deploy/dockerfiles/service.Dockerfile
else
  SERVICE_DOCKERFILE=deploy/dockerfiles/service.Dockerfile
fi

docker build -f "$SERVICE_DOCKERFILE" \
  --build-arg VULNHUNTER_VERSION="$VERSION" \
  --build-arg VULNHUNTER_BUILD_TIME="$BUILD_TIME" \
  --build-arg VULNHUNTER_GIT_COMMIT="$GIT_COMMIT" \
  --build-arg YOUNGFLOW_VERSION="$YOUNGFLOW_VERSION" \
  -t "vulnhunter-service:$VERSION" -t vulnhunter-service:latest .
docker build -f deploy/dockerfiles/web.Dockerfile -t "vulnhunter-web:$VERSION" -t vulnhunter-web:latest .
VULNFORGE_VERSION="$VULNFORGE_VERSION" VULNFORGE_COMMIT="$VULNFORGE_COMMIT" \
  scripts/build-worker-image.sh "vulnhunter-worker:$VERSION"
docker tag "vulnhunter-worker:$VERSION" vulnhunter-worker:latest
docker build -f deploy/dockerfiles/eval-worker.Dockerfile -t "vulnhunter-eval-worker:$VERSION" -t vulnhunter-eval-worker:latest .
docker pull "$POSTGRES_IMAGE"
docker pull "$MINIO_IMAGE"

release_validate_service_web_images
release_docker_save_platform "$OUT"

cp deploy/docker-compose.yml deploy/.env.example \
  deploy/install.sh deploy/upgrade.sh deploy/uninstall.sh deploy/doctor.sh "$OUT/"
mkdir -p "$OUT/lib"
cp deploy/lib/*.sh "$OUT/lib/"

release_patch_env_example "$OUT/.env.example" "$EDITION"

if [[ "$EDITION" == "community" ]]; then
  rm -f "$OUT/.secrets/license-public.pem"
  rmdir "$OUT/.secrets" 2>/dev/null || true
else
  release_copy_license_public_key "$OUT"
fi

cp -r docs/vulnhunter-srv/releases/. "$OUT/docs/" 2>/dev/null || true
cp deploy/README.md "$OUT/docs/install.md" 2>/dev/null || true
chmod +x "$OUT"/*.sh "$OUT"/lib/*.sh

release_validate_edition_artifacts "$OUT" "$EDITION"
release_validate_tree_clean "$OUT"

release_pack_sandbox "$OUT"
release_write_checksums "$OUT" "$EDITION"
release_tar_and_sha "$OUT"
