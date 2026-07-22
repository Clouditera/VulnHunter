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
  # Idempotent: if a prior dump already exists from this install, skip re-dump.
  if compgen -G "backups/db-pre-rename.*.sql.gz" >/dev/null 2>&1; then
    rename_log "existing db-pre-rename dump found — skip re-dump"
    return 0
  fi
  mkdir -p backups
  local stamp out
  stamp="$(date +%Y%m%d-%H%M%S)"
  out="backups/db-pre-rename.$stamp.sql.gz"
  rename_log "dumping database to $out"
  local pg_image="${POSTGRES_IMAGE:-postgres:16-alpine}"
  local cname="vh-rename-pgdump-$$"
  # Start postgres against existing data (trust auth for local dump only).
  # POSTGRES_USER is only used on first init; existing clusters keep their role.
  if ! docker run -d --name "$cname" \
      -v "$dir:/var/lib/postgresql/data" \
      -e POSTGRES_HOST_AUTH_METHOD=trust \
      -e POSTGRES_USER="$RENAME_OLD_DB_ROLE" \
      "$pg_image" >/dev/null; then
    rename_warn "could not start temp postgres for dump — continuing without dump"
    return 0
  fi
  local i ready=0 role=""
  for i in $(seq 1 40); do
    if docker exec "$cname" pg_isready -U "$RENAME_OLD_DB_ROLE" >/dev/null 2>&1; then
      ready=1; role="$RENAME_OLD_DB_ROLE"; break
    fi
    if docker exec "$cname" pg_isready -U "$RENAME_NEW_DB_ROLE" >/dev/null 2>&1; then
      ready=1; role="$RENAME_NEW_DB_ROLE"; break
    fi
    sleep 1
  done
  if [[ "$ready" != 1 || -z "$role" ]]; then
    rename_warn "temp postgres not ready for dump — skipping"
    docker rm -f "$cname" >/dev/null 2>&1 || true
    return 0
  fi
  if docker exec "$cname" pg_dumpall -U "$role" 2>/dev/null | gzip > "$out"; then
    rename_log "database dump ok via role=$role ($(wc -c < "$out") bytes)"
  else
    rename_warn "pg_dumpall failed — dump file may be incomplete"
    rm -f "$out"
  fi
  docker rm -f "$cname" >/dev/null 2>&1 || true
}

# ALTER DATABASE / ROLE from old names to new names against DATA_DIR/db.
# Critical: PostgreSQL refuses `ALTER ROLE <session_user> RENAME` — so we
# create a temporary SUPERUSER, rename via that session, then drop it.
# Ends with \l/\du-style assertions; non-zero if names did not land.
rename_database_identifiers() {
  local dir="${DATA_DIR:-}/db"
  [[ -d "$dir" ]] || { rename_warn "no DB dir — skip ALTER RENAME"; return 0; }
  local pg_image="${POSTGRES_IMAGE:-postgres:16-alpine}"
  local cname="vh-rename-pg-$$"
  local admin_role="vh_rename_admin_$$"
  # Sanitize role name (postgres identifiers: letters/digits/underscore)
  admin_role="vh_rename_admin"
  rename_log "renaming DB identifiers: $RENAME_OLD_DB_NAME/$RENAME_OLD_DB_ROLE → $RENAME_NEW_DB_NAME/$RENAME_NEW_DB_ROLE"
  docker run -d --name "$cname" \
    -v "$dir:/var/lib/postgresql/data" \
    -e POSTGRES_HOST_AUTH_METHOD=trust \
    -e POSTGRES_USER="$RENAME_OLD_DB_ROLE" \
    "$pg_image" >/dev/null
  local i ready=0 bootstrap_role=""
  for i in $(seq 1 40); do
    if docker exec "$cname" pg_isready -U "$RENAME_OLD_DB_ROLE" >/dev/null 2>&1; then
      ready=1; bootstrap_role="$RENAME_OLD_DB_ROLE"; break
    fi
    if docker exec "$cname" pg_isready -U "$RENAME_NEW_DB_ROLE" >/dev/null 2>&1; then
      ready=1; bootstrap_role="$RENAME_NEW_DB_ROLE"; break
    fi
    sleep 1
  done
  if [[ "$ready" != 1 || -z "$bootstrap_role" ]]; then
    docker rm -f "$cname" >/dev/null 2>&1 || true
    rename_die "temp postgres failed to become ready for DB rename"
    return 1
  fi

  # Already fully renamed? Assert both db + role, then done.
  if docker exec "$cname" psql -U "$RENAME_NEW_DB_ROLE" -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname='${RENAME_NEW_DB_NAME}'" 2>/dev/null | grep -q 1 \
     && docker exec "$cname" psql -U "$RENAME_NEW_DB_ROLE" -d postgres -tAc \
        "SELECT 1 FROM pg_roles WHERE rolname='${RENAME_NEW_DB_ROLE}'" 2>/dev/null | grep -q 1 \
     && ! docker exec "$cname" psql -U "$RENAME_NEW_DB_ROLE" -d postgres -tAc \
        "SELECT 1 FROM pg_roles WHERE rolname='${RENAME_OLD_DB_ROLE}'" 2>/dev/null | grep -q 1; then
    rename_log "database already renamed (db+role=$RENAME_NEW_DB_NAME) — skip"
    docker rm -f "$cname" >/dev/null 2>&1 || true
    return 0
  fi

  # Create a throwaway SUPERUSER so we are not the session user being renamed.
  # (session user cannot be renamed — the 31.102 silent-failure root cause.)
  if ! docker exec "$cname" psql -U "$bootstrap_role" -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${admin_role}') THEN
    CREATE ROLE ${admin_role} WITH SUPERUSER LOGIN;
  END IF;
END
\$\$;
SQL
  then
    docker rm -f "$cname" >/dev/null 2>&1 || true
    rename_die "failed to create temporary SUPERUSER ${admin_role}"
    return 1
  fi

  # Rename via the temporary admin (not the role being renamed).
  if ! docker exec "$cname" psql -U "$admin_role" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname IN ('${RENAME_OLD_DB_NAME}', '${RENAME_NEW_DB_NAME}')
    AND pid <> pg_backend_pid();
-- Database rename (idempotent)
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = '${RENAME_OLD_DB_NAME}')
     AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${RENAME_NEW_DB_NAME}') THEN
    EXECUTE 'ALTER DATABASE ${RENAME_OLD_DB_NAME} RENAME TO ${RENAME_NEW_DB_NAME}';
  END IF;
END
\$\$;
-- Role rename (idempotent); MUST NOT run as the role being renamed
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RENAME_OLD_DB_ROLE}')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RENAME_NEW_DB_ROLE}') THEN
    EXECUTE 'ALTER ROLE ${RENAME_OLD_DB_ROLE} RENAME TO ${RENAME_NEW_DB_ROLE}';
  END IF;
END
\$\$;
SQL
  then
    docker exec "$cname" psql -U "$admin_role" -d postgres -c "DROP ROLE IF EXISTS ${admin_role};" >/dev/null 2>&1 || true
    docker rm -f "$cname" >/dev/null 2>&1 || true
    rename_die "ALTER DATABASE/ROLE via temporary SUPERUSER failed"
    return 1
  fi

  # Drop temporary admin (connect as the new role if rename succeeded).
  local cleanup_role="$RENAME_NEW_DB_ROLE"
  if ! docker exec "$cname" pg_isready -U "$cleanup_role" >/dev/null 2>&1; then
    cleanup_role="$admin_role"
  fi
  docker exec "$cname" psql -U "$cleanup_role" -d postgres -c "DROP ROLE IF EXISTS ${admin_role};" >/dev/null 2>&1 || true

  # Hard assertions — refuse to claim success without on-disk proof.
  local db_ok=0 role_ok=0 old_role_gone=0
  if docker exec "$cname" psql -U "$RENAME_NEW_DB_ROLE" -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='${RENAME_NEW_DB_NAME}'" 2>/dev/null | grep -q 1; then
    db_ok=1
  fi
  if docker exec "$cname" psql -U "$RENAME_NEW_DB_ROLE" -d postgres -tAc \
      "SELECT 1 FROM pg_roles WHERE rolname='${RENAME_NEW_DB_ROLE}'" 2>/dev/null | grep -q 1; then
    role_ok=1
  fi
  if ! docker exec "$cname" psql -U "$RENAME_NEW_DB_ROLE" -d postgres -tAc \
      "SELECT 1 FROM pg_roles WHERE rolname='${RENAME_OLD_DB_ROLE}'" 2>/dev/null | grep -q 1; then
    old_role_gone=1
  fi
  docker rm -f "$cname" >/dev/null 2>&1 || true

  if [[ "$db_ok" != 1 || "$role_ok" != 1 || "$old_role_gone" != 1 ]]; then
    rename_die "DB rename assertion failed (db_ok=$db_ok role_ok=$role_ok old_role_gone=$old_role_gone) — names did not land on disk"
    return 1
  fi
  rename_log "database identifiers renamed and asserted (db+role=$RENAME_NEW_DB_NAME)"
}

# Count files under a path (host-side; root-owned trees are still listable).
rename_count_files() {
  local p="$1"
  [[ -d "$p" ]] || { printf '0'; return 0; }
  find "$p" -type f 2>/dev/null | wc -l | tr -d ' '
}

# Pure decision helper for the MinIO step (unit-tested).
# Args: old_bucket_dir new_bucket_dir old_meta_dir new_meta_dir
# Prints one of: skip | meta_only | full_copy | create_empty | fail:mismatch
rename_minio_plan() {
  local old_b="$1" new_b="$2" old_m="$3" new_m="$4"
  local old_count new_count
  old_count="$(rename_count_files "$old_b")"
  new_count="$(rename_count_files "$new_b")"

  if [[ ! -d "$old_b" && ! -d "$new_b" ]]; then
    printf 'create_empty'
    return 0
  fi
  if [[ -d "$new_b" && -d "$old_b" && "$old_count" != "$new_count" ]]; then
    printf 'fail:mismatch'
    return 0
  fi
  if [[ -d "$new_b" && ( ! -d "$old_b" || "$old_count" == "$new_count" ) ]]; then
    # Content ok — metadata may still be missing (the 31.102 half-migrate case).
    if [[ -d "$old_m" && ! -d "$new_m" ]]; then
      printf 'meta_only'
      return 0
    fi
    printf 'skip'
    return 0
  fi
  # new missing (old present) → full copy
  printf 'full_copy'
}

# Run a root command against the MinIO data dir via docker (handles root-owned
# .minio.sys and bucket objects written by the MinIO container). Offline-safe:
# only uses images already loaded locally (minio → postgres → any), never pulls.
rename_minio_root_sh() {
  local dir="$1"; shift
  local image=""
  for image in \
      "${MINIO_IMAGE:-}" \
      "minio/minio:RELEASE.2025-09-07T16-13-09Z" \
      "${POSTGRES_IMAGE:-postgres:16-alpine}" \
      "alpine:3.20"; do
    [[ -n "$image" ]] || continue
    if docker image inspect "$image" >/dev/null 2>&1; then
      break
    fi
    image=""
  done
  if [[ -z "$image" ]]; then
    image="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>' | head -n 1)"
  fi
  [[ -n "$image" ]] || { rename_die "no local docker image available for root minio copy"; return 1; }
  docker run --rm --user 0:0 --entrypoint sh \
    -v "$dir:/data" \
    "$image" \
    -c "$*"
}

# Copy old MinIO bucket → artifact-store at the filesystem layer. All writes go
# through a root docker run so root-owned .minio.sys is writable. Idempotent:
#   skip       — content+metadata already ok
#   meta_only  — content ok, only copy .minio.sys/buckets/<new> (31.102 resume)
#   full_copy  — content missing → cp -a bucket + metadata
#   create_empty — neither side present
#   fail       — content counts disagree
rename_migrate_minio_bucket() {
  local dir="${DATA_DIR:-}/minio"
  [[ -d "$dir" ]] || { rename_warn "no minio dir — skip bucket migrate"; return 0; }

  local old_bucket="$RENAME_OLD_BUCKET"
  local new_bucket="$RENAME_NEW_BUCKET"
  local old_bucket_dir="$dir/$old_bucket"
  local new_bucket_dir="$dir/$new_bucket"
  local old_meta="$dir/.minio.sys/buckets/$old_bucket"
  local new_meta="$dir/.minio.sys/buckets/$new_bucket"

  local plan
  plan="$(rename_minio_plan "$old_bucket_dir" "$new_bucket_dir" "$old_meta" "$new_meta")"
  rename_log "minio plan=$plan (old_files=$(rename_count_files "$old_bucket_dir") new_files=$(rename_count_files "$new_bucket_dir"))"

  case "$plan" in
    skip)
      rename_log "bucket '$new_bucket' content+metadata already ok — skip"
      ;;
    meta_only)
      rename_log "bucket content ok; copying missing metadata via docker root"
      rename_minio_root_sh "$dir" "
        set -e
        mkdir -p /data/.minio.sys/buckets
        cp -a /data/.minio.sys/buckets/${old_bucket} /data/.minio.sys/buckets/${new_bucket}
      " || { rename_die "root bucket metadata copy failed"; return 1; }
      ;;
    full_copy)
      rename_log "copying MinIO bucket via docker root: $old_bucket → $new_bucket"
      rename_minio_root_sh "$dir" "
        set -e
        cp -a /data/${old_bucket} /data/${new_bucket}
        if [ -d /data/.minio.sys/buckets/${old_bucket} ]; then
          mkdir -p /data/.minio.sys/buckets
          rm -rf /data/.minio.sys/buckets/${new_bucket}
          cp -a /data/.minio.sys/buckets/${old_bucket} /data/.minio.sys/buckets/${new_bucket}
        else
          mkdir -p /data/.minio.sys/buckets/${new_bucket}
        fi
      " || { rename_die "root bucket full copy failed"; return 1; }
      ;;
    create_empty)
      rename_log "creating empty new bucket via docker root"
      rename_minio_root_sh "$dir" \
        "mkdir -p /data/${new_bucket} /data/.minio.sys/buckets/${new_bucket}" \
        || return 1
      ;;
    fail:mismatch)
      rename_die "bucket file count mismatch (old=$(rename_count_files "$old_bucket_dir") new=$(rename_count_files "$new_bucket_dir")) — refusing to continue"
      return 1
      ;;
    *)
      rename_die "unknown minio plan: $plan"
      return 1
      ;;
  esac

  # Final count check when old side still exists.
  if [[ -d "$old_bucket_dir" ]]; then
    local old_count new_count
    old_count="$(rename_count_files "$old_bucket_dir")"
    new_count="$(rename_count_files "$new_bucket_dir")"
    rename_log "object file count old=$old_count new=$new_count"
    if [[ "$old_count" != "$new_count" ]]; then
      rename_die "bucket file count mismatch after copy (old=$old_count new=$new_count)"
      return 1
    fi
  fi

  rename_log "bucket migration complete; old bucket '$old_bucket' retained as rollback"
  mkdir -p backups
  cat > "backups/minio-bucket-rollback.txt" <<EOF
Old MinIO bucket retained on disk: ${dir}/${old_bucket}
New MinIO bucket in use:           ${dir}/${new_bucket}
After confirming the upgrade, remove the old bucket directory (and
${dir}/.minio.sys/buckets/${old_bucket} if present).
EOF
}

# List known SandboxPlane container names (31.102 uses sandbox-plane).
rename_plane_containers() {
  local n
  for n in sandbox-plane sandbox_plane; do
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$n"; then
      printf '%s
' "$n"
    fi
  done
}

# BEFORE compose up: free the old network so compose can create vulnhunter-internal
# with its own labels/subnet. Do NOT pre-create the new network — unlabeled
# pre-create collides with compose (31.102 P0-2).
rename_prepare_network() {
  local plane
  while IFS= read -r plane; do
    [[ -n "$plane" ]] || continue
    rename_log "disconnecting $plane from $RENAME_OLD_NETWORK (pre-compose)"
    docker network disconnect -f "$RENAME_OLD_NETWORK" "$plane" 2>/dev/null || true
  done < <(rename_plane_containers)

  # Drop any leftover unlabeled new-network from a previous failed attempt so
  # compose can recreate it with project labels.
  if docker network ls --format '{{.Name}}' | grep -qx "$RENAME_NEW_NETWORK"; then
    local labeled
    labeled="$(docker network inspect "$RENAME_NEW_NETWORK" --format '{{index .Labels "com.docker.compose.network"}}' 2>/dev/null || true)"
    if [[ -z "$labeled" ]]; then
      rename_log "removing unlabeled pre-existing $RENAME_NEW_NETWORK so compose can own it"
      docker network rm "$RENAME_NEW_NETWORK" >/dev/null 2>&1 || true
    fi
  fi

  if docker network ls --format '{{.Name}}' | grep -qx "$RENAME_OLD_NETWORK"; then
    local remaining
    remaining="$(docker network inspect "$RENAME_OLD_NETWORK" --format '{{len .Containers}}' 2>/dev/null || echo 0)"
    if [[ "$remaining" == "0" ]]; then
      docker network rm "$RENAME_OLD_NETWORK" >/dev/null 2>&1 || true
      rename_log "removed empty old network $RENAME_OLD_NETWORK"
    else
      # Force-disconnect any residual endpoints (stopped containers etc.) then rm.
      rename_warn "old network $RENAME_OLD_NETWORK still has $remaining endpoint(s) — force-clearing"
      local eid ename
      while IFS=$'\t' read -r eid ename; do
        [[ -n "$ename" ]] || continue
        docker network disconnect -f "$RENAME_OLD_NETWORK" "$ename" 2>/dev/null || true
      done < <(docker network inspect "$RENAME_OLD_NETWORK" --format '{{range $k,$v := .Containers}}{{println $k "\t" $v.Name}}{{end}}' 2>/dev/null || true)
      docker network rm "$RENAME_OLD_NETWORK" >/dev/null 2>&1 \
        || rename_warn "could not remove $RENAME_OLD_NETWORK — compose may hit subnet conflict"
    fi
  fi
}

# AFTER compose up: attach SandboxPlane to the compose-managed new network.
# If the plane was started with NetworkMode pinned to the old network name,
# connect to the new bridge network is enough (multi-network); we already
# force-disconnected the old one in rename_prepare_network. If connect still
# fails, recreate the plane container on the new network preserving mounts/env.
rename_attach_plane_to_new_network() {
  if ! docker network ls --format '{{.Name}}' | grep -qx "$RENAME_NEW_NETWORK"; then
    rename_warn "new network $RENAME_NEW_NETWORK missing after compose up — plane not attached"
    return 0
  fi
  local plane
  while IFS= read -r plane; do
    [[ -n "$plane" ]] || continue
    # Already on the new network?
    if docker inspect "$plane" --format '{{json .NetworkSettings.Networks}}' 2>/dev/null \
        | grep -q "\"$RENAME_NEW_NETWORK\""; then
      rename_log "$plane already on $RENAME_NEW_NETWORK"
      continue
    fi
    rename_log "attaching $plane to $RENAME_NEW_NETWORK"
    if docker network connect "$RENAME_NEW_NETWORK" "$plane" 2>/dev/null; then
      rename_log "$plane connected to $RENAME_NEW_NETWORK"
      continue
    fi
    # Connect failed (e.g. NetworkMode hard-pin). Recreate on the new network.
    rename_warn "connect failed for $plane — recreating container on $RENAME_NEW_NETWORK"
    rename_recreate_plane_on_new_network "$plane" \
      || rename_warn "failed to recreate $plane on new network — dynamic path may be broken"
  done < <(rename_plane_containers)
}

# Recreate a SandboxPlane container on the new network, preserving image, env,
# mounts, restart policy, and published ports. Used only when live connect fails.
rename_recreate_plane_on_new_network() {
  local plane="$1"
  local image
  image="$(docker inspect "$plane" --format '{{.Config.Image}}' 2>/dev/null || true)"
  [[ -n "$image" ]] || return 1

  local tmp_env tmp_labels
  tmp_env="$(mktemp)"
  docker inspect "$plane" --format '{{range .Config.Env}}{{println .}}{{end}}' > "$tmp_env"

  # Build -v and -p args from inspect
  local run_args=(run -d --name "$plane" --network "$RENAME_NEW_NETWORK")
  local restart
  restart="$(docker inspect "$plane" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || echo unless-stopped)"
  [[ -n "$restart" && "$restart" != "no" ]] && run_args+=(--restart "$restart")

  local src dst mode
  while IFS=$'\t' read -r src dst mode; do
    [[ -n "$src" && -n "$dst" ]] || continue
    if [[ "$mode" == *"ro"* ]]; then
      run_args+=(-v "${src}:${dst}:ro")
    else
      run_args+=(-v "${src}:${dst}")
    fi
  done < <(docker inspect "$plane" --format '{{range .Mounts}}{{println .Source "\t" .Destination "\t" .Mode}}{{end}}' 2>/dev/null || true)

  local host_ip host_port container_port
  while IFS=$'\t' read -r host_ip host_port container_port; do
    [[ -n "$host_port" && -n "$container_port" ]] || continue
    if [[ -n "$host_ip" && "$host_ip" != "0.0.0.0" && "$host_ip" != "::" ]]; then
      run_args+=(-p "${host_ip}:${host_port}:${container_port}")
    else
      run_args+=(-p "${host_port}:${container_port}")
    fi
  done < <(docker inspect "$plane" --format '{{range $p,$arr := .NetworkSettings.Ports}}{{range $arr}}{{println .HostIp "\t" .HostPort "\t" $p}}{{end}}{{end}}' 2>/dev/null | sed 's|/tcp||g' || true)

  # env-file
  run_args+=(--env-file "$tmp_env")
  run_args+=("$image")
  # Preserve original command if any
  local cmd
  cmd="$(docker inspect "$plane" --format '{{json .Config.Cmd}}' 2>/dev/null || echo null)"

  docker stop "$plane" >/dev/null 2>&1 || true
  docker rename "$plane" "${plane}-old-$$" >/dev/null 2>&1 || docker rm -f "$plane" >/dev/null 2>&1 || true

  if [[ "$cmd" != "null" && -n "$cmd" ]]; then
    # shellcheck disable=SC2068
    if ! docker "${run_args[@]}" >/dev/null; then
      docker rename "${plane}-old-$$" "$plane" >/dev/null 2>&1 || true
      rm -f "$tmp_env"
      return 1
    fi
  else
    # shellcheck disable=SC2068
    if ! docker "${run_args[@]}" >/dev/null; then
      docker rename "${plane}-old-$$" "$plane" >/dev/null 2>&1 || true
      rm -f "$tmp_env"
      return 1
    fi
  fi
  docker rm -f "${plane}-old-$$" >/dev/null 2>&1 || true
  rm -f "$tmp_env"
  rename_log "recreated $plane on $RENAME_NEW_NETWORK"
}

# Back-compat alias used by upgrade.sh after compose up.
rename_cleanup_old_network() {
  rename_attach_plane_to_new_network
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

4. If the DB was renamed, start a temp postgres against DATA_DIR/db and **probe first**:
   \`SELECT datname FROM pg_database; SELECT rolname FROM pg_roles;\`
   Only reverse when the new names are actually present (do not blind ALTER):
   ALTER DATABASE ${RENAME_NEW_DB_NAME} RENAME TO ${RENAME_OLD_DB_NAME};
   ALTER ROLE ${RENAME_NEW_DB_ROLE} RENAME TO ${RENAME_OLD_DB_ROLE};
   (Use a temporary SUPERUSER — session user cannot rename itself.)

5. Point MINIO_BUCKET back to \`${RENAME_OLD_BUCKET}\` (old bucket was retained).
   A leftover \`${RENAME_NEW_BUCKET}\` directory is harmless to the old stack; delete manually if desired.

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
