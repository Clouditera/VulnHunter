#!/usr/bin/env bash
# Shared release helpers for VulnHunter open-core + enterprise dual-repo builds.
# Source from scripts/build-release.sh (OSS or private). Do not execute directly.
#
# Required caller vars before use (set defaults in entry script):
#   ROOT VERSION OUT MINIO_IMAGE POSTGRES_IMAGE GIT_COMMIT BUILD_TIME
#   YOUNGFLOW_VERSION VULNFORGE_VERSION VULNFORGE_COMMIT EDITION
# Optional:
#   PLATFORM_ONLY SANDBOX_PLANE_REPO SANDBOX_PLANE_REF WITH_QEMU
#   LICENSE_PUBLIC_KEY_FILE CORE_DIR (private monorepo: path to core submodule)

set -euo pipefail

release_die() { echo "release: $*" >&2; exit 1; }

release_require_cmd() {
  command -v "$1" >/dev/null 2>&1 || release_die "missing command: $1"
}

# ── Paths ────────────────────────────────────────────────────────────
# CORE_ROOT: open-core tree (same as ROOT on OSS; core/ submodule on private).
release_core_root() {
  if [[ -n "${CORE_DIR:-}" ]]; then
    echo "$CORE_DIR"
  elif [[ -d "$ROOT/core/packages/service" ]]; then
    echo "$ROOT/core"
  else
    echo "$ROOT"
  fi
}

# ── VERSION.json ─────────────────────────────────────────────────────
release_write_version_json() {
  local out="${1:-$OUT}"
  mkdir -p "$out"
  cat > "$out/VERSION.json" << JSON
{
  "product": "vulnhunter",
  "version": "$VERSION",
  "edition": "$EDITION",
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
    "postgres": "$POSTGRES_IMAGE",
    "minio": "$MINIO_IMAGE"
  }
}
JSON
}

# ── VulnForge submodule pin ──────────────────────────────────────────
release_check_vulnforge() {
  local core
  core="$(release_core_root)"
  git -C "$core" submodule update --init --recursive
  local actual
  actual="$(git -C "$core/flows/vulnforge" rev-parse HEAD)"
  if [[ "$actual" != "$VULNFORGE_COMMIT" ]]; then
    release_die "VulnForge baseline mismatch: expected $VULNFORGE_COMMIT, got $actual"
  fi
  [[ -f "$core/flows/vulnforge/flow.audit.yaml" ]] \
    || release_die "missing flows/vulnforge/flow.audit.yaml; run git submodule update --init --recursive"
  [[ -f "$core/flows/vulnforge/extensions/output-contract/package.json" ]] \
    || release_die "missing flows/vulnforge/extensions/output-contract/package.json"
  # pi-web-access nested submodule must be materialized (empty submodule dirs
  # pack silently and the worker image then lacks web search in research/hunt).
  [[ -f "$core/flows/vulnforge/extensions/pi-web-access/index.ts" ]] \
    || release_die "missing flows/vulnforge/extensions/pi-web-access/index.ts; run git submodule update --init --recursive"
}

# ── Image sourcemap / declaration guard ──────────────────────────────
release_validate_no_runtime_sourcemaps() {
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

release_validate_service_web_images() {
  release_validate_no_runtime_sourcemaps "vulnhunter-service:$VERSION" "/app/packages /app/public"
  release_validate_no_runtime_sourcemaps "vulnhunter-web:$VERSION" "/usr/share/nginx/html"
}

# ── Worker image content gates ───────────────────────────────────────
# pi-web-access is a NESTED submodule of flows/vulnforge — if the build tree
# never ran `git submodule update --init --recursive`, it lands in the image as
# an empty dir and research/hunt silently lose web search. The Dockerfile
# build-time probes already fail the build; this re-checks the tagged image.
release_validate_worker_image() {
  # --entrypoint sh bypasses scan-mode.sh ENTRYPOINT (exits 1 without TASK_ID)
  docker run --rm --entrypoint sh "vulnhunter-worker:$VERSION" -lc '
    test -f /opt/vulnhunter/flows/vulnforge/extensions/pi-web-access/index.ts \
      || { echo "worker image: pi-web-access/index.ts missing" >&2; exit 1; }
    test -d /opt/vulnhunter/flows/vulnforge/extensions/pi-web-access/node_modules \
      || { echo "worker image: pi-web-access node_modules missing" >&2; exit 1; }
  '
}

# ── docker save ──────────────────────────────────────────────────────
release_docker_save_platform() {
  local out="${1:-$OUT}"
  mkdir -p "$out/images"
  docker save "vulnhunter-service:$VERSION" -o "$out/images/vulnhunter-service.tar"
  docker save "vulnhunter-web:$VERSION" -o "$out/images/vulnhunter-web.tar"
  docker save "vulnhunter-worker:$VERSION" -o "$out/images/vulnhunter-worker.tar"
  docker save "$POSTGRES_IMAGE" -o "$out/images/postgres-16-alpine.tar"
  docker save "$MINIO_IMAGE" -o "$out/images/minio.tar"
}

# ── License public key (enterprise/saas only) ────────────────────────
release_copy_license_public_key() {
  local out="${1:-$OUT}"
  local src="${LICENSE_PUBLIC_KEY_FILE:-$HOME/.vulnhunt-issuer/license-public.pem}"
  mkdir -p "$out/.secrets"
  if [[ ! -f "$src" ]]; then
    release_die "missing license public key: $src (set LICENSE_PUBLIC_KEY_FILE for $EDITION release)"
  fi
  cp "$src" "$out/.secrets/license-public.pem"
  [[ -s "$out/.secrets/license-public.pem" ]] \
    || release_die "release validation failed: missing .secrets/license-public.pem"
}

# ── Patch .env.example image tags + EDITION ──────────────────────────
release_patch_env_example() {
  local env_file="$1"
  local edition="$2"
  sed -i "s|^SERVICE_IMAGE=.*|SERVICE_IMAGE=vulnhunter-service:$VERSION|" "$env_file"
  sed -i "s|^WEB_IMAGE=.*|WEB_IMAGE=vulnhunter-web:$VERSION|" "$env_file"
  sed -i "s|^WORKER_IMAGE=.*|WORKER_IMAGE=vulnhunter-worker:$VERSION|" "$env_file"
  if grep -q "^EDITION=" "$env_file"; then
    sed -i "s|^EDITION=.*|EDITION=$edition|" "$env_file"
  else
    printf '\nEDITION=%s\n' "$edition" >> "$env_file"
  fi
}

# ── Edition-specific compose/env guards ──────────────────────────────
release_validate_edition_artifacts() {
  local out="${1:-$OUT}"
  local edition="$2"
  case "$edition" in
    community)
      grep -qx "EDITION=community" "$out/.env.example" \
        || release_die "release validation failed: .env.example must set EDITION=community"
      # community must not require license material
      if [[ -f "$out/.secrets/license-public.pem" ]]; then
        release_die "release validation failed: community package must not ship license-public.pem"
      fi
      ;;
    enterprise|saas)
      grep -qx "EDITION=$edition" "$out/.env.example" \
        || release_die "release validation failed: .env.example must set EDITION=$edition"
      [[ -s "$out/.secrets/license-public.pem" ]] \
        || release_die "release validation failed: missing .secrets/license-public.pem"
      grep -q "VULNHUNTER_LICENSE_PUBLIC_KEY_FILE:.*run/secrets/license-public.pem" "$out/docker-compose.yml" \
        || release_die "release validation failed: compose missing VULNHUNTER_LICENSE_PUBLIC_KEY_FILE"
      grep -q "LICENSE_PUBLIC_KEY_FILE.*run/secrets/license-public.pem:ro" "$out/docker-compose.yml" \
        || release_die "release validation failed: compose missing license public key mount"
      ;;
    *)
      release_die "unknown EDITION=$edition"
      ;;
  esac
}

# ── Tree-wide secret / sourcemap guards ──────────────────────────────
release_validate_tree_clean() {
  local out="${1:-$OUT}"
  local secret_exclude="$out/.secrets/license-public.pem"
  if find "$out" -type f ! -path "$out/images/*" ! -path "$secret_exclude" -print0 2>/dev/null \
    | xargs -0 -r grep -Il "BEGIN .*PRIVATE KEY" | grep -q .; then
    release_die "release validation failed: private key material detected in release files"
  fi
  if find "$out" -type f ! -path "$out/images/*" \( -name "*.map" -o -name "*.d.ts" -o -name "*.d.ts.map" \) | grep -q .; then
    release_die "release validation failed: map/declaration files found in release files"
  fi
  if find "$out" -type f ! -path "$out/images/*" ! -path "$secret_exclude" -print0 2>/dev/null \
    | xargs -0 -r grep -Il "sourceMappingURL" | grep -q .; then
    release_die "release validation failed: sourceMappingURL found in release files"
  fi
  [[ -x "$out/lib/rename-migrate.sh" ]] \
    || release_die "release validation failed: missing lib/rename-migrate.sh (required by upgrade.sh)"
  release_validate_root_artifacts "$out"
}

# ── Root-level artifact checklist (architect 2026-08-11) ─────────────
# Three packaging defects in one day traced to missing root files.
# Hard-fail if any required root-level file is absent.
release_validate_root_artifacts() {
  local out="${1:-$OUT}"
  local required=(
    "upgrade.sh"
    "install.sh"
    "docker-compose.yml"
    ".env.example"
    "lib/common.sh"
    "lib/instance-upgrade.sh"
    "worker-assets/scan-mode.sh"
    "VERSION.json"
  )
  for f in "${required[@]}"; do
    [[ -f "$out/$f" ]] \
      || release_die "release validation failed: missing root artifact: $f"
  done
  if [[ "${EDITION:-}" != "community" ]]; then
    local pem="$out/.secrets/license-public.pem"
    [[ -s "$pem" ]] \
      || release_die "release validation failed: $EDITION edition requires non-empty .secrets/license-public.pem"
  fi
  release_validate_image_arches "$out"
}

# ── Image architecture assertion (architect 2026-08-11) ──────────────
# ARM postgres/minio images mixed into an x86 package caused 15-min
# crash-loop on 31.106. Verify every platform image has the expected
# architecture via docker inspect (images are loaded locally during build).
release_validate_image_arches() {
  local out="${1:-$OUT}"
  local expected_arch="${TARGET_ARCH:-amd64}"
  local images=(
    "vulnhunter-service:$VERSION"
    "vulnhunter-web:$VERSION"
    "vulnhunter-worker:$VERSION"
    "${POSTGRES_IMAGE:-postgres:16-alpine}"
    "${MINIO_IMAGE:-minio/minio:RELEASE.2025-09-07T16-13-09Z}"
  )
  local img arch
  for img in "${images[@]}"; do
    arch=$(docker inspect "$img" --format '{{.Architecture}}' 2>/dev/null) || arch="inspect_failed"
    if [[ "$arch" != "$expected_arch" ]]; then
      release_die "release validation failed: $img architecture is '$arch', expected '$expected_arch'"
    fi
    echo "  $img: $arch ✓"
  done
}

# ── SandboxPlane substack ────────────────────────────────────────────
# Default: include sandbox (fish 2026-07-31). PLATFORM_ONLY=1 skips.
release_pack_sandbox() {
  local out="${1:-$OUT}"
  local core
  core="$(release_core_root)"

  if [[ "${PLATFORM_ONLY:-0}" == "1" ]]; then
    SANDBOX_PLANE_REF=""
  else
    SANDBOX_PLANE_REF="${SANDBOX_PLANE_REF:-v0.3.2}"
  fi
  SANDBOX_PLANE_REPO="${SANDBOX_PLANE_REPO:-$core/../sandbox-center}"
  # Prefer sibling of monorepo root when CORE is nested
  if [[ ! -d "$SANDBOX_PLANE_REPO" && -d "$ROOT/../sandbox-center" ]]; then
    SANDBOX_PLANE_REPO="$ROOT/../sandbox-center"
  fi

  if [[ -z "${SANDBOX_PLANE_REF:-}" ]]; then
    echo "SANDBOX_PLANE_REF unset — platform-only package (no sandbox/)"
    return 0
  fi

  echo "packing sandbox substack from $SANDBOX_PLANE_REPO @ $SANDBOX_PLANE_REF"
  [[ -d "$SANDBOX_PLANE_REPO" ]] || release_die "SANDBOX_PLANE_REPO not found: $SANDBOX_PLANE_REPO"
  local plane_head plane_short plane_want
  plane_head="$(git -C "$SANDBOX_PLANE_REPO" rev-parse HEAD)"
  plane_short="$(git -C "$SANDBOX_PLANE_REPO" rev-parse --short HEAD)"
  plane_want="$(git -C "$SANDBOX_PLANE_REPO" rev-parse "$SANDBOX_PLANE_REF^{commit}" 2>/dev/null)" \
    || release_die "ref not found: $SANDBOX_PLANE_REF"
  [[ "$plane_head" == "$plane_want" ]] \
    || release_die "sandbox repo HEAD != $SANDBOX_PLANE_REF (checkout it first)"
  if [[ -n "$(git -C "$SANDBOX_PLANE_REPO" status --porcelain)" ]]; then
    echo "warning: sandbox plane repo is dirty" >&2
  fi

  local sandbox_deploy="$core/deploy/sandbox"
  [[ -d "$sandbox_deploy" ]] || sandbox_deploy="$ROOT/deploy/sandbox"
  mkdir -p "$out/sandbox/images" "$out/sandbox/images-optional" "$out/sandbox/secrets"
  cp "$sandbox_deploy/install.sh" "$sandbox_deploy/upgrade.sh" "$out/sandbox/"
  cp "$sandbox_deploy/docker-compose.yml" "$sandbox_deploy/config.yaml" "$sandbox_deploy/profiles.yaml" "$out/sandbox/"
  chmod +x "$out/sandbox/install.sh" "$out/sandbox/upgrade.sh"

  local plane_service_image
  plane_service_image="$(grep -E 'image:[[:space:]]*sandbox-plane/service' "$out/sandbox/docker-compose.yml" | head -1 | sed -E 's/.*image:[[:space:]]*//' | tr -d '\"' | tr -d "'")"
  [[ -n "$plane_service_image" ]] || release_die "cannot parse plane service image"

  local img base
  save_if_present() {
    local image="$1" dest="$2"
    if docker image inspect "$image" >/dev/null 2>&1; then
      echo "docker save $image -> $dest"
      docker save "$image" -o "$dest"
    else
      release_die "missing required sandbox image: $image (build/pull it first)"
    fi
  }

  save_if_present "$plane_service_image" "$out/sandbox/images/sandbox-plane-service.tar"
  while IFS= read -r img; do
    [[ -n "$img" ]] || continue
    base="$(echo "$img" | tr '/:' '__')"
    save_if_present "$img" "$out/sandbox/images/${base}.tar"
  done < <(grep -E '^\s+image:\s+' "$out/sandbox/profiles.yaml" | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")

  while IFS= read -r img; do
    [[ -n "$img" ]] || continue
    base="$(echo "$img" | tr '/:' '__')"
    [[ -f "$out/sandbox/images/${base}.tar" ]] || release_die "assert fail: missing $img tar"
  done < <(grep -E '^\s+image:\s+' "$out/sandbox/profiles.yaml" | sed -E 's/.*image:[[:space:]]*//' | tr -d '"' | tr -d "'")

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
  ' "$out/VERSION.json" "$SANDBOX_PLANE_REF" "$plane_short" "$plane_service_image" "$out/sandbox/profiles.yaml"

  local docs_src="$core/docs/vulnhunter-srv/releases/sandbox-install.md"
  [[ -f "$docs_src" ]] || docs_src="$ROOT/docs/vulnhunter-srv/releases/sandbox-install.md"
  cp "$docs_src" "$out/docs/sandbox-install.md" 2>/dev/null || true
  echo "sandbox substack packed"
}

# ── Checksums AFTER VERSION rewrite / sandbox pack ───────────────────
release_write_checksums() {
  local out="${1:-$OUT}"
  local edition="${2:-$EDITION}"
  (
    cd "$out"
    find images -type f -name '*.tar' -print | sort
    printf '%s\n' docker-compose.yml .env.example install.sh doctor.sh upgrade.sh uninstall.sh VERSION.json
    if [[ "$edition" != "community" ]]; then
      printf '%s\n' .secrets/license-public.pem
    fi
    find lib -type f -name '*.sh' -print 2>/dev/null | sort
    find docs -type f -print 2>/dev/null | sort
    if [[ -d sandbox ]]; then
      find sandbox -type f ! -path 'sandbox/secrets/*' -print | sort
    fi
  ) | while IFS= read -r file; do
    [[ -f "$out/$file" ]] && sha256sum "$out/$file"
  done | sed "s|  $out/|  |" > "$out/checksums.sha256"

  ( cd "$out" && sha256sum -c checksums.sha256 >/dev/null ) \
    || release_die "release validation failed: checksums.sha256 does not match tree"
}

release_tar_and_sha() {
  local out="${1:-$OUT}"
  local final="$out.tar.gz"
  local tmp="$final.tmp.$$"
  # Atomic pack: write to a temp name first so a killed/interrupted tar never
  # leaves a complete-looking truncated artifact at the final path.
  rm -f "$tmp"
  tar -C "$(dirname "$out")" -czf "$tmp" "$(basename "$out")" \
    || { rm -f "$tmp"; release_die "tar failed for $out"; }

  # Self-verification hard gate: a pack that cannot prove itself is a build failure.
  release_verify_pack "$tmp" "$out"
  mv "$tmp" "$final"

  (
    cd "$(dirname "$out")"
    sha256sum "$(basename "$out").tar.gz"
  ) > "$out.tar.gz.sha256"
  echo "release package: $out.tar.gz"
  echo "release checksum: $out.tar.gz.sha256"
}

# Verify a built pack: gzip integrity + full re-extract + internal checksums
# + key file presence. Any failure aborts the release (P0 lesson 2026-08-04:
# a truncated 2.3.3 pack with missing docker-compose.yml nearly shipped).
release_verify_pack() {
  local pack="$1" out="${2:-$OUT}"
  echo "release: verifying pack integrity $(basename "$pack")"
  gzip -t "$pack" || release_die "pack gzip integrity check failed: $pack"

  local verify_dir
  verify_dir="$(mktemp -d "${TMPDIR:-/tmp}/release-verify.XXXXXX")"
  tar -xzf "$pack" -C "$verify_dir" \
    || { rm -rf "$verify_dir"; release_die "pack re-extract failed: $pack"; }

  local extracted="$verify_dir/$(basename "$out")"
  [[ -d "$extracted" ]] \
    || { rm -rf "$verify_dir"; release_die "pack missing top dir $(basename "$out")"; }

  local f
  for f in docker-compose.yml .env.example install.sh upgrade.sh doctor.sh uninstall.sh VERSION.json checksums.sha256; do
    [[ -f "$extracted/$f" ]] \
      || { rm -rf "$verify_dir"; release_die "pack missing key file: $f"; }
  done

  ( cd "$extracted" && sha256sum -c checksums.sha256 >/dev/null ) \
    || { rm -rf "$verify_dir"; release_die "pack internal checksums mismatch after re-extract"; }

  rm -rf "$verify_dir"
  echo "release: pack self-verification passed"
}

# ── Private monorepo: core submodule pin == OSS v$VERSION tag ────────
# CORE_OSS_GIT: path or URL to open-core repo with tags (optional file:// or remote).
release_check_core_tag_pin() {
  local core="${CORE_DIR:-$ROOT/core}"
  [[ -d "$core/.git" || -f "$core/.git" ]] || release_die "core submodule missing at $core"
  local core_head want
  core_head="$(git -C "$core" rev-parse HEAD)"
  if [[ -n "${CORE_OSS_GIT:-}" ]]; then
    want="$(git -C "$CORE_OSS_GIT" rev-parse "v${VERSION}^{commit}" 2>/dev/null)" \
      || release_die "OSS tag v$VERSION not found in CORE_OSS_GIT=$CORE_OSS_GIT"
  else
    # Prefer tag inside submodule itself
    want="$(git -C "$core" rev-parse "v${VERSION}^{commit}" 2>/dev/null)" || want=""
    if [[ -z "$want" ]]; then
      echo "warning: core has no tag v$VERSION — skipping pin check (set CORE_OSS_GIT for hard fail)" >&2
      return 0
    fi
  fi
  [[ "$core_head" == "$want" ]] \
    || release_die "core HEAD ($core_head) != OSS v$VERSION ($want) — refuse commercial pack drift"
  echo "core pin OK: v$VERSION = $core_head"
}
