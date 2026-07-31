#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}" 
OUT="${OUT:-$ROOT/release/vulnhunter-release-$VERSION}"
MINIO_IMAGE="${MINIO_IMAGE:-minio/minio:RELEASE.2025-09-07T16-13-09Z}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"
GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
YOUNGFLOW_VERSION="${YOUNGFLOW_VERSION:-0.3.8}"
VULNFORGE_VERSION="${VULNFORGE_VERSION:-2.0-5-g1782ef6}"
VULNFORGE_COMMIT="${VULNFORGE_COMMIT:-1782ef6d99db58fda74c8e1524b9237ca39cad2c}"

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
  "product": "vulnhunter",
  "version": "$VERSION",
  "buildTime": "$BUILD_TIME",
  "gitCommit": "$GIT_COMMIT",
  "youngflowVersion": "$YOUNGFLOW_VERSION",
  "vulnforgeVersion": "$VULNFORGE_VERSION",
  "vulnforgeCommit": "$VULNFORGE_COMMIT",
  "licenseSchema": "v1",
  "images": {
    "service": "vulnhunter-service:$VERSION",
    "web": "vulnhunter-web:$VERSION",
    "worker": "vulnhunter-worker:$VERSION",
    "evalWorker": "vulnhunter-eval-worker:$VERSION",
    "postgres": "$POSTGRES_IMAGE",
    "minio": "$MINIO_IMAGE"
  }
}
JSON

pnpm turbo run build --filter=@vulnhunter/service --filter=@vulnhunter/web
pnpm --filter @vulnhunter/worker-bridge build
if [[ ! -f flows/vulnforge/flow.audit.yaml ]]; then
  echo "missing flows/vulnforge/flow.audit.yaml; run git submodule update --init --recursive" >&2
  exit 1
fi
if [[ ! -f flows/vulnforge/extensions/output-contract/package.json ]]; then
  echo "missing flows/vulnforge/extensions/output-contract/package.json; run git submodule update --init --recursive" >&2
  exit 1
fi
docker build -f deploy/dockerfiles/service.Dockerfile \
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
validate_no_runtime_sourcemaps "vulnhunter-service:$VERSION" "/app/packages /app/public"
validate_no_runtime_sourcemaps "vulnhunter-web:$VERSION" "/usr/share/nginx/html"

docker save "vulnhunter-service:$VERSION" -o "$OUT/images/vulnhunter-service.tar"
docker save "vulnhunter-web:$VERSION" -o "$OUT/images/vulnhunter-web.tar"
docker save "vulnhunter-worker:$VERSION" -o "$OUT/images/vulnhunter-worker.tar"
docker save "vulnhunter-eval-worker:$VERSION" -o "$OUT/images/vulnhunter-eval-worker.tar"
docker save "$POSTGRES_IMAGE" -o "$OUT/images/postgres-16-alpine.tar"
docker save "$MINIO_IMAGE" -o "$OUT/images/minio.tar"

cp deploy/docker-compose.yml deploy/.env.example deploy/install.sh deploy/upgrade.sh deploy/uninstall.sh deploy/doctor.sh "$OUT/"
# upgrade.sh sources lib/rename-migrate.sh (VulnHunter rename migration). Ship the whole lib/.
mkdir -p "$OUT/lib"
cp deploy/lib/*.sh "$OUT/lib/"
LICENSE_PUBLIC_KEY_SOURCE="${LICENSE_PUBLIC_KEY_FILE:-$HOME/.vulnhunt-issuer/license-public.pem}"
if [[ ! -f "$LICENSE_PUBLIC_KEY_SOURCE" ]]; then
  echo "missing license public key: $LICENSE_PUBLIC_KEY_SOURCE" >&2
  echo "Set LICENSE_PUBLIC_KEY_FILE to the issuer public key PEM before building an enterprise release." >&2
  exit 1
fi
cp "$LICENSE_PUBLIC_KEY_SOURCE" "$OUT/.secrets/license-public.pem"
sed -i "s|^SERVICE_IMAGE=.*|SERVICE_IMAGE=vulnhunter-service:$VERSION|" "$OUT/.env.example"
sed -i "s|^WEB_IMAGE=.*|WEB_IMAGE=vulnhunter-web:$VERSION|" "$OUT/.env.example"
sed -i "s|^WORKER_IMAGE=.*|WORKER_IMAGE=vulnhunter-worker:$VERSION|" "$OUT/.env.example"
sed -i "s|^EVAL_WORKER_IMAGE=.*|EVAL_WORKER_IMAGE=vulnhunter-eval-worker:$VERSION|" "$OUT/.env.example"
if grep -q "^EDITION=" "$OUT/.env.example"; then
  sed -i "s|^EDITION=.*|EDITION=enterprise|" "$OUT/.env.example"
else
  printf '\nEDITION=enterprise\n' >> "$OUT/.env.example"
fi

# Enterprise release guardrails. Official customer/offline packages must boot with
# license routes/UI enabled and must never ship private issuer material.
grep -qx "EDITION=enterprise" "$OUT/.env.example" || { echo "release validation failed: .env.example must set EDITION=enterprise" >&2; exit 1; }
[[ -s "$OUT/.secrets/license-public.pem" ]] || { echo "release validation failed: missing .secrets/license-public.pem" >&2; exit 1; }
grep -q "VULNHUNTER_LICENSE_PUBLIC_KEY_FILE:.*run/secrets/license-public.pem" "$OUT/docker-compose.yml" || { echo "release validation failed: compose missing VULNHUNTER_LICENSE_PUBLIC_KEY_FILE" >&2; exit 1; }
grep -q "LICENSE_PUBLIC_KEY_FILE.*run/secrets/license-public.pem:ro" "$OUT/docker-compose.yml" || { echo "release validation failed: compose missing license public key mount" >&2; exit 1; }
if find "$OUT" -type f ! -path "$OUT/images/*" ! -path "$OUT/.secrets/license-public.pem" -print0 | xargs -0 grep -Il "BEGIN .*PRIVATE KEY" | grep -q .; then
  echo "release validation failed: private key material detected in release files" >&2
  exit 1
fi
cp -r docs/vulnhunter-srv/releases/. "$OUT/docs/"
cp deploy/README.md "$OUT/docs/install.md" 2>/dev/null || true
chmod +x "$OUT"/*.sh "$OUT"/lib/*.sh
[[ -x "$OUT/lib/rename-migrate.sh" ]] || { echo "release validation failed: missing lib/rename-migrate.sh (required by upgrade.sh)" >&2; exit 1; }
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
  find lib -type f -name '*.sh' -print | sort
  find docs -type f -print | sort
  if [[ -d "$OUT/sandbox" ]]; then
    find sandbox -type f ! -path 'sandbox/secrets/*' -print | sort
  fi
) | while IFS= read -r file; do
  [[ -f "$OUT/$file" ]] && sha256sum "$OUT/$file"
done | sed "s|  $OUT/|  |" > "$OUT/checksums.sha256"


# ── SandboxPlane optional substack ─────────────────────────────────────
# Sandbox substack is included by default (fish 2026-07-31).
# Override: SANDBOX_PLANE_REF= for platform-only; or set another tag/commit.
SANDBOX_PLANE_REPO="${SANDBOX_PLANE_REPO:-$ROOT/../sandbox-center}"
# Empty SANDBOX_PLANE_REF after default means "use default tag" unless PLATFORM_ONLY=1.
if [[ "${PLATFORM_ONLY:-0}" == "1" ]]; then
  SANDBOX_PLANE_REF=""
else
  SANDBOX_PLANE_REF="${SANDBOX_PLANE_REF:-v0.3.2}"
fi
WITH_QEMU="${WITH_QEMU:-1}"  # legacy flag ignored; full pack is default
if [[ -n "$SANDBOX_PLANE_REF" ]]; then
  echo "packing sandbox substack from $SANDBOX_PLANE_REPO @ $SANDBOX_PLANE_REF"
  [[ -d "$SANDBOX_PLANE_REPO" ]] || { echo "SANDBOX_PLANE_REPO not found: $SANDBOX_PLANE_REPO" >&2; exit 1; }
  PLANE_HEAD="$(git -C "$SANDBOX_PLANE_REPO" rev-parse HEAD)"
  PLANE_SHORT="$(git -C "$SANDBOX_PLANE_REPO" rev-parse --short HEAD)"
  # soft check: warn if dirty; hard check ref if tag exists
  if [[ -n "$(git -C "$SANDBOX_PLANE_REPO" status --porcelain)" ]]; then
    echo "warning: sandbox plane repo is dirty" >&2
  fi
  mkdir -p "$OUT/sandbox/images" "$OUT/sandbox/images-optional" "$OUT/sandbox/secrets"
  cp deploy/sandbox/install.sh deploy/sandbox/upgrade.sh "$OUT/sandbox/"
  cp deploy/sandbox/docker-compose.yml deploy/sandbox/config.yaml deploy/sandbox/profiles.yaml "$OUT/sandbox/"
  chmod +x "$OUT/sandbox/install.sh" "$OUT/sandbox/upgrade.sh"

  # Resolve image tags from profiles + compose
  PLANE_SERVICE_IMAGE="$(grep -E 'image:[[:space:]]*sandbox-plane/service' "$OUT/sandbox/docker-compose.yml" | head -1 | sed -E 's/.*image:[[:space:]]*//' | tr -d '\"' | tr -d "'")"
  [[ -n "$PLANE_SERVICE_IMAGE" ]] || { echo "cannot parse plane service image" >&2; exit 1; }

  save_if_present() {
    local image="$1" dest="$2"
    if docker image inspect "$image" >/dev/null 2>&1; then
      echo "docker save $image -> $dest"
      docker save "$image" -o "$dest"
    else
      echo "missing required sandbox image: $image (build/pull it first)" >&2
      exit 1
    fi
  }

  save_if_present "$PLANE_SERVICE_IMAGE" "$OUT/sandbox/images/sandbox-plane-service.tar"
  # profile images
  # Default full pack: every profile image (including qemu) into sandbox/images/ — fail if missing
  while IFS= read -r img; do
    [[ -n "$img" ]] || continue
    base="$(echo "$img" | tr '/:' '__')"
    save_if_present "$img" "$OUT/sandbox/images/${base}.tar"
  done < <(grep -E '^\s+image:\s+' "$OUT/sandbox/profiles.yaml" | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")

  while IFS= read -r img; do
    [[ -n "$img" ]] || continue
    base="$(echo "$img" | tr '/:' '__')"
    [[ -f "$OUT/sandbox/images/${base}.tar" ]] || { echo "assert fail: missing $img tar" >&2; exit 1; }
  done < <(grep -E '^\s+image:\s+' "$OUT/sandbox/profiles.yaml" | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")

  # Patch VERSION.json with sandbox_plane block (rewrite via node)
  node -e '
    const fs=require("fs");
    const p=process.argv[1];
    const j=JSON.parse(fs.readFileSync(p,"utf8"));
    j.sandbox_plane={
      version: process.argv[2],
      commit: process.argv[3],
      images: {
        service: process.argv[4],
        profiles: fs.readFileSync(process.argv[5],"utf8").match(/image:\s*(\S+)/g)||[]
      }
    };
    fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
  ' "$OUT/VERSION.json" "$SANDBOX_PLANE_REF" "$PLANE_SHORT" "$PLANE_SERVICE_IMAGE" "$OUT/sandbox/profiles.yaml"

  cp docs/vulnhunter-srv/releases/sandbox-install.md "$OUT/docs/sandbox-install.md" 2>/dev/null || true
  echo "sandbox substack packed"
else
  echo "SANDBOX_PLANE_REF unset — platform-only package (no sandbox/)"
fi


tar -C "$(dirname "$OUT")" -czf "$OUT.tar.gz" "$(basename "$OUT")"
(
  cd "$(dirname "$OUT")"
  sha256sum "$(basename "$OUT").tar.gz"
) > "$OUT.tar.gz.sha256"
echo "release package: $OUT.tar.gz"
echo "release checksum: $OUT.tar.gz.sha256"
