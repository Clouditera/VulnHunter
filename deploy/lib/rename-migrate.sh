#!/usr/bin/env bash
# VulnAgent → VulnHunter one-shot rename migration helpers (R3).
# Sourced by upgrade.sh. Safe no-op when the release package still targets
# the old product name (lets R2/R3 land in either order).
#
# Design: docs/architecture/rename-vulnhunter-full-inventory-and-migration-design-v1.0.md

# shellcheck disable=SC2034
RENAME_OLD_PRODUCT="vulnagent"
RENAME_NEW_PRODUCT="vulnhunter"
RENAME_OLD_BUCKET="vulnagent"
RENAME_NEW_BUCKET="artifact-store"
RENAME_OLD_NETWORK="vulnagent-internal"
RENAME_NEW_NETWORK="vulnhunter-internal"
RENAME_OLD_DB_NAME="vulnagent"
RENAME_NEW_DB_NAME="vulnhunter"
RENAME_OLD_DB_ROLE="vulnagent"
RENAME_NEW_DB_ROLE="vulnhunter"
RENAME_OLD_MASTER_KEY="vulnagent-master.key"
RENAME_NEW_MASTER_KEY="vulnhunter-master.key"
RENAME_OLD_INSTALL_MANIFEST=".vulnagent-install.json"
RENAME_NEW_INSTALL_MANIFEST=".vulnhunter-install.json"

RENAME_OLD_CONTAINERS=(vulnagent-web vulnagent-service vulnagent-db vulnagent-minio)
RENAME_NEW_CONTAINERS=(vulnhunter-web vulnhunter-service vulnhunter-db vulnhunter-minio)

# ---------- pure helpers (unit-tested) ----------

# True when a DATA_DIR path itself embeds the old product token.
rename_data_dir_needs_move() {
  local path="${1:-}"
  [[ -n "$path" ]] || return 1
  [[ "$path" == *"${RENAME_OLD_PRODUCT}"* ]]
}

# Map a path containing the old product token onto the new name.
# Only the path string is rewritten; non-matching paths are echoed unchanged.
rename_map_data_dir_path() {
  local path="${1:-}"
  printf '%s' "${path//${RENAME_OLD_PRODUCT}/${RENAME_NEW_PRODUCT}}"
}

# Rewrite one .env body (stdin → stdout) for the rename.
# - VULNAGENT_* keys → VULNHUNTER_*
# - image tags vulnagent- → vulnhunter-
# - DATA_DIR / MASTER_KEY paths containing vulnagent → vulnhunter
# - MINIO_BUCKET=vulnagent → artifact-store
# - DOCKER_NETWORK / compose network refs
# - master key filename
rename_rewrite_env_body() {
  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Preserve comments / blanks
    if [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]]; then
      printf '%s\n' "$line"
      continue
    fi
    if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      printf '%s\n' "$line"
      continue
    fi
    key="${line%%=*}"
    value="${line#*=}"

    # Key rename VULNAGENT_* → VULNHUNTER_*
    if [[ "$key" == VULNAGENT_* ]]; then
      key="VULNHUNTER_${key#VULNAGENT_}"
    fi

    case "$key" in
      SERVICE_IMAGE|WEB_IMAGE|WORKER_IMAGE|EVAL_WORKER_IMAGE)
        value="${value//vulnagent-/vulnhunter-}"
        ;;
      DATA_DIR|MASTER_KEY_FILE|VULNHUNTER_MASTER_KEY_FILE|VULNAGENT_MASTER_KEY_FILE)
        value="${value//${RENAME_OLD_PRODUCT}/${RENAME_NEW_PRODUCT}}"
        value="${value//${RENAME_OLD_MASTER_KEY}/${RENAME_NEW_MASTER_KEY}}"
        ;;
      MINIO_BUCKET)
        if [[ "$value" == "$RENAME_OLD_BUCKET" ]]; then
          value="$RENAME_NEW_BUCKET"
        fi
        ;;
      DOCKER_NETWORK)
        if [[ "$value" == "$RENAME_OLD_NETWORK" ]]; then
          value="$RENAME_NEW_NETWORK"
        fi
        ;;
      DATABASE_URL)
        # postgresql://vulnagent:pass@db:5432/vulnagent → vulnhunter
        value="${value//\/${RENAME_OLD_DB_NAME}/\/${RENAME_NEW_DB_NAME}}"
        value="${value//:\/\/${RENAME_OLD_DB_ROLE}:/:\/\/${RENAME_NEW_DB_ROLE}:}"
        ;;
      DB_USER|POSTGRES_USER|POSTGRES_DB)
        if [[ "$value" == "$RENAME_OLD_DB_ROLE" ]]; then
          value="$RENAME_NEW_DB_ROLE"
        fi
        ;;
    esac

    # Catch-all path token rewrite for remaining values that embed the old product.
    if [[ "$value" == *"${RENAME_OLD_PRODUCT}"* ]]; then
      case "$key" in
        # Do not rewrite free-form secrets/passwords that might coincidentally match.
        DB_PASSWORD|MINIO_ACCESS_KEY|MINIO_SECRET_KEY|SANDBOXPLANE_TOKEN) ;;
        *) value="${value//${RENAME_OLD_PRODUCT}/${RENAME_NEW_PRODUCT}}" ;;
      esac
    fi

    printf '%s=%s\n' "$key" "$value"
  done
}

# ---------- package / environment detection ----------

# True when this release package already targets VulnHunter (R2 landed).
rename_package_targets_new_product() {
  if [[ -f docker-compose.yml ]] && grep -qE 'container_name:[[:space:]]*vulnhunter-service' docker-compose.yml; then
    return 0
  fi
  if [[ -f VERSION.json ]] && grep -qE '"product"[[:space:]]*:[[:space:]]*"vulnhunter"' VERSION.json; then
    return 0
  fi
  if [[ -f .env.example ]] && grep -qE 'vulnhunter-service' .env.example; then
    return 0
  fi
  return 1
}

# True when the live install still carries old naming.
rename_install_has_old_naming() {
  # .env markers
  if [[ -f .env ]]; then
    if grep -qE '^(DATA_DIR|SERVICE_IMAGE|WEB_IMAGE|WORKER_IMAGE|MINIO_BUCKET|DOCKER_NETWORK|VULNAGENT_|MASTER_KEY_FILE)=.*vulnagent' .env \
      || grep -qE '^MINIO_BUCKET=vulnagent$' .env \
      || grep -qE '^VULNAGENT_' .env; then
      return 0
    fi
  fi
  # running/stopped old containers
  local c
  for c in "${RENAME_OLD_CONTAINERS[@]}"; do
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
      return 0
    fi
  done
  # old network
  if docker network ls --format '{{.Name}}' 2>/dev/null | grep -qx "$RENAME_OLD_NETWORK"; then
    return 0
  fi
  # old install manifest
  [[ -f "$RENAME_OLD_INSTALL_MANIFEST" ]] && return 0
  return 1
}

rename_migration_needed() {
  rename_package_targets_new_product || return 1
  rename_install_has_old_naming || return 1
  return 0
}

# ---------- quiet window ----------

# Abort when any managed worker (old or new prefix) is running.
# Override: ALLOW_ACTIVE_SCAN_UPGRADE=1
rename_quiet_window_gate() {
  local running
  running="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^(va-scan-|va-prepare-|vh-scan-|vh-prepare-)' || true)"
  if [[ -z "$running" ]]; then
    return 0
  fi
  if [[ "${ALLOW_ACTIVE_SCAN_UPGRADE:-}" == "1" ]]; then
    echo "[upgrade] WARNING: active worker containers present; ALLOW_ACTIVE_SCAN_UPGRADE=1 set — continuing" >&2
    printf '%s\n' "$running" >&2
    return 0
  fi
  echo "[upgrade] active scan/prepare workers detected; refusing rename/upgrade while work is in flight." >&2
  echo "[upgrade] Stop or cancel running tasks first, or set ALLOW_ACTIVE_SCAN_UPGRADE=1 to override." >&2
  printf '%s\n' "$running" >&2
  return 1
}

# ---------- side-effecting steps ----------

rename_log() { echo "[upgrade:rename] $*"; }
rename_warn() { echo "[upgrade:rename] WARNING: $*" >&2; }
rename_die() { echo "[upgrade:rename] ERROR: $*" >&2; return 1; }

# Stop and remove old-named stack containers (keep data dirs).
rename_stop_old_stack() {
  local c
  rename_log "stopping old-named stack containers"
  for c in "${RENAME_OLD_CONTAINERS[@]}"; do
    docker stop "$c" >/dev/null 2>&1 || true
  done
  for c in "${RENAME_OLD_CONTAINERS[@]}"; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
}

# Move DATA_DIR when the path embeds the old product token; leave a symlink at the old path.
rename_move_data_dir_if_needed() {
  local old_dir="${DATA_DIR:-}"
  [[ -n "$old_dir" ]] || return 0
  if ! rename_data_dir_needs_move "$old_dir"; then
    rename_log "DATA_DIR '$old_dir' has no old-product token — path left unchanged"
    return 0
  fi
  local new_dir
  new_dir="$(rename_map_data_dir_path "$old_dir")"
  if [[ "$old_dir" == "$new_dir" ]]; then
    return 0
  fi
  if [[ -e "$new_dir" && ! -L "$new_dir" ]]; then
    # Target already exists as a real directory — only OK if old is already a symlink to it
    if [[ -L "$old_dir" && "$(readlink -f "$old_dir" 2>/dev/null || true)" == "$(readlink -f "$new_dir" 2>/dev/null || true)" ]]; then
      DATA_DIR="$new_dir"
      export DATA_DIR
      rename_log "DATA_DIR already migrated ($old_dir → $new_dir)"
      return 0
    fi
    rename_die "target data dir already exists: $new_dir (refusing to overwrite)"
    return 1
  fi
  if [[ ! -e "$old_dir" ]]; then
    rename_warn "DATA_DIR $old_dir does not exist; updating reference only → $new_dir"
    DATA_DIR="$new_dir"
    export DATA_DIR
    return 0
  fi
  if [[ -L "$old_dir" ]]; then
    rename_log "DATA_DIR $old_dir is already a symlink — adopting target"
    DATA_DIR="$(readlink -f "$old_dir")"
    export DATA_DIR
    return 0
  fi
  rename_log "moving DATA_DIR: $old_dir → $new_dir"
  mkdir -p "$(dirname "$new_dir")"
  mv "$old_dir" "$new_dir"
  ln -s "$new_dir" "$old_dir"
  rename_log "left compatibility symlink: $old_dir → $new_dir"
  DATA_DIR="$new_dir"
  export DATA_DIR
}

# Rename master key file inside DATA_DIR/.secrets if present.
rename_master_key_file() {
  local dir="${DATA_DIR:-}"
  [[ -n "$dir" ]] || return 0
  local secrets="$dir/.secrets"
  local old="$secrets/$RENAME_OLD_MASTER_KEY"
  local new="$secrets/$RENAME_NEW_MASTER_KEY"
  if [[ -f "$new" ]]; then
    rename_log "master key already at $new"
    return 0
  fi
  if [[ -f "$old" ]]; then
    rename_log "renaming master key: $old → $new"
    mv "$old" "$new"
    return 0
  fi
  # Also handle release-dir relative secrets
  if [[ -f ".secrets/$RENAME_OLD_MASTER_KEY" && ! -f ".secrets/$RENAME_NEW_MASTER_KEY" ]]; then
    mv ".secrets/$RENAME_OLD_MASTER_KEY" ".secrets/$RENAME_NEW_MASTER_KEY"
    rename_log "renamed release-dir master key"
  fi
}

# Atomically rewrite .env for the new product. Keeps a backup beside it.
rename_rewrite_env_file() {
  [[ -f .env ]] || rename_die "no .env to rewrite"
  local stamp backup tmp
  stamp="$(date +%Y%m%d-%H%M%S)"
  backup="backups/.env.rename-pre.$stamp"
  mkdir -p backups
  cp .env "$backup"
  rename_log "backed up .env → $backup"
  tmp=".env.rename.tmp"
  # Ensure DATA_DIR in the body reflects any move we just did
  if [[ -n "${DATA_DIR:-}" ]]; then
    if grep -qE '^DATA_DIR=' .env; then
      sed -i "s|^DATA_DIR=.*|DATA_DIR=${DATA_DIR}|" .env
    else
      printf 'DATA_DIR=%s\n' "$DATA_DIR" >> .env
    fi
  fi
  rename_rewrite_env_body < .env > "$tmp"
  # Force critical keys even if absent from the old file
  if ! grep -qE '^MINIO_BUCKET=' "$tmp"; then
    printf 'MINIO_BUCKET=%s\n' "$RENAME_NEW_BUCKET" >> "$tmp"
  fi
  if ! grep -qE '^DOCKER_NETWORK=' "$tmp"; then
    printf 'DOCKER_NETWORK=%s\n' "$RENAME_NEW_NETWORK" >> "$tmp"
  fi
  mv "$tmp" .env
  rename_log "rewrote .env for VulnHunter naming"
}

# Dump the DB (best-effort) before rename. Uses a throwaway postgres container
# against DATA_DIR/db when the old db container is already stopped.
rename_backup_database() {
  local dir="${DATA_DIR:-}/db"
  [[ -d "$dir" ]] || { rename_warn "no DB dir at $dir — skip dump"; return 0; }
  mkdir -p backups
  local stamp out
  stamp="$(date +%Y%m%d-%H%M%S)"
  out="backups/db-pre-rename.$stamp.sql.gz"
  rename_log "dumping database to $out"
  local pg_image="${POSTGRES_IMAGE:-postgres:16-alpine}"
  local cname="vh-rename-pgdump-$$"
  # Start postgres against existing data (trust auth for local dump only)
  if ! docker run -d --name "$cname" \
      -v "$dir:/var/lib/postgresql/data" \
      -e POSTGRES_HOST_AUTH_METHOD=trust \
      -e POSTGRES_USER="$RENAME_OLD_DB_ROLE" \
      "$pg_image" >/dev/null; then
    rename_warn "could not start temp postgres for dump — continuing without dump"
    return 0
  fi
  local i ready=0
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 30; do
    if docker exec "$cname" pg_isready -U "$RENAME_OLD_DB_ROLE" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" != 1 ]]; then
    rename_warn "temp postgres not ready for dump — skipping"
    docker rm -f "$cname" >/dev/null 2>&1 || true
    return 0
  fi
  if docker exec "$cname" pg_dumpall -U "$RENAME_OLD_DB_ROLE" 2>/dev/null | gzip > "$out"; then
    rename_log "database dump ok ($(wc -c < "$out") bytes)"
  else
    rename_warn "pg_dumpall failed — dump file may be incomplete"
    rm -f "$out"
  fi
  docker rm -f "$cname" >/dev/null 2>&1 || true
}

# ALTER DATABASE / ROLE from old names to new names against DATA_DIR/db.
rename_database_identifiers() {
  local dir="${DATA_DIR:-}/db"
  [[ -d "$dir" ]] || { rename_warn "no DB dir — skip ALTER RENAME"; return 0; }
  local pg_image="${POSTGRES_IMAGE:-postgres:16-alpine}"
  local cname="vh-rename-pg-$$"
  rename_log "renaming DB identifiers: $RENAME_OLD_DB_NAME/$RENAME_OLD_DB_ROLE → $RENAME_NEW_DB_NAME/$RENAME_NEW_DB_ROLE"
  docker run -d --name "$cname" \
    -v "$dir:/var/lib/postgresql/data" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e POSTGRES_USER="$RENAME_OLD_DB_ROLE" \
    "$pg_image" >/dev/null
  local i ready=0
  for i in $(seq 1 40); do
    if docker exec "$cname" pg_isready -U "$RENAME_OLD_DB_ROLE" >/dev/null 2>&1 \
      || docker exec "$cname" pg_isready -U "$RENAME_NEW_DB_ROLE" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [[ "$ready" != 1 ]]; then
    docker rm -f "$cname" >/dev/null 2>&1 || true
    rename_die "temp postgres failed to become ready for DB rename"
    return 1
  fi

  # Already renamed?
  if docker exec "$cname" psql -U "$RENAME_NEW_DB_ROLE" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='${RENAME_NEW_DB_NAME}'" 2>/dev/null | grep -q 1; then
    rename_log "database already renamed to $RENAME_NEW_DB_NAME"
    docker rm -f "$cname" >/dev/null 2>&1 || true
    return 0
  fi

  # Terminate backends on old DB, then rename. Connect via old role to postgres db.
  docker exec "$cname" psql -U "$RENAME_OLD_DB_ROLE" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = '${RENAME_OLD_DB_NAME}' AND pid <> pg_backend_pid();
ALTER DATABASE ${RENAME_OLD_DB_NAME} RENAME TO ${RENAME_NEW_DB_NAME};
ALTER ROLE ${RENAME_OLD_DB_ROLE} RENAME TO ${RENAME_NEW_DB_ROLE};
SQL
  local rc=$?
  docker rm -f "$cname" >/dev/null 2>&1 || true
  if [[ $rc -ne 0 ]]; then
    rename_die "ALTER DATABASE/ROLE failed (rc=$rc)"
    return 1
  fi
  rename_log "database identifiers renamed"
}

# Copy old MinIO bucket → artifact-store at the filesystem layer (MinIO layout is
# one directory per bucket under DATA_DIR/minio). No external mc image required
# (offline-safe). Leaves the old bucket directory as rollback.
rename_migrate_minio_bucket() {
  local dir="${DATA_DIR:-}/minio"
  [[ -d "$dir" ]] || { rename_warn "no minio dir — skip bucket migrate"; return 0; }

  local old_bucket_dir="$dir/$RENAME_OLD_BUCKET"
  local new_bucket_dir="$dir/$RENAME_NEW_BUCKET"
  local old_meta="$dir/.minio.sys/buckets/$RENAME_OLD_BUCKET"
  local new_meta="$dir/.minio.sys/buckets/$RENAME_NEW_BUCKET"

  if [[ -d "$new_bucket_dir" ]]; then
    local old_count new_count
    old_count=0; new_count=0
    [[ -d "$old_bucket_dir" ]] && old_count="$(find "$old_bucket_dir" -type f 2>/dev/null | wc -l | tr -d ' ')"
    new_count="$(find "$new_bucket_dir" -type f 2>/dev/null | wc -l | tr -d ' ')"
    if [[ ! -d "$old_bucket_dir" || "$old_count" == "$new_count" ]]; then
      rename_log "bucket '$RENAME_NEW_BUCKET' already present (files=$new_count) — skip copy"
      return 0
    fi
    rename_warn "new bucket exists but file count differs (old=$old_count new=$new_count); re-copying"
    rm -rf "$new_bucket_dir"
  fi

  if [[ ! -d "$old_bucket_dir" ]]; then
    rename_log "old bucket dir '$old_bucket_dir' absent — creating empty new bucket dir"
    mkdir -p "$new_bucket_dir"
    if [[ -d "$dir/.minio.sys/buckets" && ! -d "$new_meta" ]]; then
      mkdir -p "$new_meta"
    fi
    return 0
  fi

  rename_log "copying MinIO bucket filesystem: $RENAME_OLD_BUCKET → $RENAME_NEW_BUCKET (data stays on host)"
  # cp -a preserves modes/timestamps; old dir left intact for rollback.
  cp -a "$old_bucket_dir" "$new_bucket_dir"

  # Copy bucket metadata if MinIO has written any (config/policy/etc.).
  if [[ -d "$old_meta" && ! -d "$new_meta" ]]; then
    mkdir -p "$(dirname "$new_meta")"
    cp -a "$old_meta" "$new_meta"
    rename_log "copied MinIO bucket metadata"
  fi

  local old_count new_count
  old_count="$(find "$old_bucket_dir" -type f 2>/dev/null | wc -l | tr -d ' ')"
  new_count="$(find "$new_bucket_dir" -type f 2>/dev/null | wc -l | tr -d ' ')"
  rename_log "object file count old=$old_count new=$new_count"
  if [[ "$old_count" != "$new_count" ]]; then
    rename_die "bucket file count mismatch (old=$old_count new=$new_count) — refusing to continue"
    return 1
  fi

  rename_log "bucket migration complete; old bucket '$RENAME_OLD_BUCKET' retained as rollback"
  mkdir -p backups
  cat > "backups/minio-bucket-rollback.txt" <<EOF
Old MinIO bucket retained on disk: ${dir}/${RENAME_OLD_BUCKET}
New MinIO bucket in use:           ${dir}/${RENAME_NEW_BUCKET}
After confirming the upgrade, remove the old bucket directory (and
${dir}/.minio.sys/buckets/${RENAME_OLD_BUCKET} if present).
EOF
}

# Ensure the new docker network exists and reattach SandboxPlane if present.
rename_prepare_network() {
  if ! docker network ls --format '{{.Name}}' | grep -qx "$RENAME_NEW_NETWORK"; then
    rename_log "creating network $RENAME_NEW_NETWORK"
    docker network create --driver bridge "$RENAME_NEW_NETWORK" >/dev/null
  else
    rename_log "network $RENAME_NEW_NETWORK already exists"
  fi

  # SandboxPlane may be named sandbox-plane (31.102) — reconnect for dynamic continuity.
  local plane
  for plane in sandbox-plane sandbox_plane; do
    if docker ps -a --format '{{.Names}}' | grep -qx "$plane"; then
      rename_log "attaching $plane to $RENAME_NEW_NETWORK"
      docker network connect "$RENAME_NEW_NETWORK" "$plane" 2>/dev/null \
        || rename_log "$plane already on $RENAME_NEW_NETWORK (or connect skipped)"
    fi
  done
}

# After new stack is up: detach plane from old network and remove it if empty.
rename_cleanup_old_network() {
  local plane
  for plane in sandbox-plane sandbox_plane; do
    if docker ps -a --format '{{.Names}}' | grep -qx "$plane"; then
      docker network disconnect "$RENAME_OLD_NETWORK" "$plane" 2>/dev/null || true
    fi
  done
  # Only remove old network if nothing is attached
  local remaining
  remaining="$(docker network inspect "$RENAME_OLD_NETWORK" --format '{{len .Containers}}' 2>/dev/null || echo 0)"
  if [[ "$remaining" == "0" ]]; then
    docker network rm "$RENAME_OLD_NETWORK" >/dev/null 2>&1 || true
    rename_log "removed empty old network $RENAME_OLD_NETWORK"
  else
    rename_warn "old network $RENAME_OLD_NETWORK still has $remaining endpoint(s) — left in place"
  fi
}

# Promote install manifest filename.
rename_install_manifest_file() {
  if [[ -f "$RENAME_OLD_INSTALL_MANIFEST" && ! -f "$RENAME_NEW_INSTALL_MANIFEST" ]]; then
    mv "$RENAME_OLD_INSTALL_MANIFEST" "$RENAME_NEW_INSTALL_MANIFEST"
    rename_log "renamed install manifest → $RENAME_NEW_INSTALL_MANIFEST"
  fi
}

# Write a short rollback runbook next to backups/.
rename_write_rollback_notes() {
  mkdir -p backups
  local note="backups/RENAME-ROLLBACK.md"
  cat > "$note" <<EOF
# VulnHunter rename rollback notes

Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)

If the post-rename stack fails and you must restore the previous VulnAgent layout:

1. Stop the new stack:
   docker rm -f vulnhunter-web vulnhunter-service vulnhunter-db vulnhunter-minio 2>/dev/null || true

2. Restore .env from backups/.env.rename-pre.* (latest).

3. If DATA_DIR was moved, remove the compatibility symlink and move the directory back:
   rm -f <old-path-symlink>
   mv <new-path> <old-path>

4. If the DB was renamed, start a temp postgres against DATA_DIR/db and reverse:
   ALTER DATABASE ${RENAME_NEW_DB_NAME} RENAME TO ${RENAME_OLD_DB_NAME};
   ALTER ROLE ${RENAME_NEW_DB_ROLE} RENAME TO ${RENAME_OLD_DB_ROLE};

5. Point MINIO_BUCKET back to \`${RENAME_OLD_BUCKET}\` (old bucket was retained).

6. Reattach SandboxPlane to \`${RENAME_OLD_NETWORK}\` if needed:
   docker network connect ${RENAME_OLD_NETWORK} sandbox-plane

7. Start the previous release directory's compose project (untouched by this script).

DB dump (if taken): backups/db-pre-rename.*.sql.gz
EOF
  rename_log "rollback notes → $note"
}

# ---------- orchestrator ----------

# Full one-shot migration. Call after quiet-window gate + source .env, before
# compose up of the new-named stack. No-op when not needed.
rename_run_migration() {
  if ! rename_migration_needed; then
    if rename_package_targets_new_product; then
      rename_log "package is VulnHunter but install has no old naming — skip rename migration"
    else
      rename_log "package still targets VulnAgent — skip rename migration (R2 not in this package)"
    fi
    return 0
  fi

  rename_log "=== VulnAgent → VulnHunter rename migration starting ==="
  rename_write_rollback_notes
  rename_stop_old_stack
  rename_backup_database
  rename_move_data_dir_if_needed
  rename_master_key_file
  rename_database_identifiers
  rename_migrate_minio_bucket
  rename_rewrite_env_file
  rename_install_manifest_file
  rename_prepare_network

  # Re-source rewritten env for the rest of upgrade.sh
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a

  rename_log "=== rename migration complete — proceeding with new-named stack bring-up ==="
}
