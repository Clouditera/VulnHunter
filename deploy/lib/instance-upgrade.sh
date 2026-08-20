#!/usr/bin/env bash
# Self-contained instance upgrade (design v1.0 §4.2, batch 2).
# Requires lib/common.sh + lib/instance-dir.sh already sourced.
# Entry: run_instance_upgrade PKG_ROOT INSTANCE_DIR
# Env flags: FORCE=1 (allow downgrade), WITH_RUNNING=1 (skip quiet-window gate).
# shellcheck shell=bash

# ── semver compare: return 0 when $1 < $2 (both X.Y.Z, suffixes ignored) ──
semver_lt() {
  local a="${1%%[-+]*}" b="${2%%[-+]*}"
  local IFS=.
  local -a av=($a) bv=($b)
  local i x y
  for i in 0 1 2; do
    x="${av[i]:-0}"; y="${bv[i]:-0}"
    x="${x%%[^0-9]*}"; y="${y%%[^0-9]*}"
    [[ -z "$x" ]] && x=0; [[ -z "$y" ]] && y=0
    ((10#$x < 10#$y)) && return 0
    ((10#$x > 10#$y)) && return 1
  done
  return 1
}

# ── .env three-way merge (design §3, six rules) ─────────────────────
# Args: new_template old_template env_file
# Rules:
#  1. key in new template, absent in .env            -> append new default
#  2. key in both, .env value == old template value -> update to new default
#  3. key in both, .env value != old template value -> keep user value (log if new default differs)
#  4. key active in .env, in old template, gone from new template -> comment as deprecated
#  5. key in .env, never in templates               -> keep (user-private)
#  6. generated secrets                              -> kept implicitly by rule 3
merge_env_three_way() {
  local new_tpl="$1" old_tpl="$2" env_file="$3"
  env_file="$(readlink -f "$env_file")"
  [[ -f "$new_tpl" && -f "$env_file" ]] || { echo "[upgrade] merge: missing inputs" >&2; return 1; }
  # No old template snapshot -> degrade to add-only (documented in design §4.4)
  local have_old=1
  [[ -f "$old_tpl" ]] || have_old=0
  (( have_old )) || echo "[upgrade] merge: no .env.template snapshot — degraded to add-only mode"

  local key new_val old_val cur_val
  # Rules 1-3: walk new template keys
  while IFS= read -r line; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    new_val="${line#*=}"
    cur_val="$(grep -E "^${key}=" "$env_file" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
    if ! grep -qE "^${key}=" "$env_file"; then
      printf '%s=%s\n' "$key" "$new_val" >> "$env_file"
      echo "[upgrade] merge: added new key $key"
      continue
    fi
    old_val=""
    if (( have_old )); then
      old_val="$(grep -E "^${key}=" "$old_tpl" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
    fi
    if (( have_old )) && [[ "$cur_val" == "$old_val" ]]; then
      if [[ "$new_val" != "$old_val" ]]; then
        sed -i "s|^${key}=.*|${key}=${new_val}|" "$env_file"
        echo "[upgrade] merge: updated default $key"
      fi
    else
      if [[ "$cur_val" != "$new_val" ]]; then
        echo "[upgrade] merge: kept custom value for $key (new default differs)"
      fi
    fi
  done < "$new_tpl"

  # Rule 4: deprecated keys (active in .env, known to old template, absent in new)
  if (( have_old )); then
    while IFS= read -r line; do
      [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
      key="${line%%=*}"
      grep -qE "^${key}=" "$new_tpl" && continue
      if grep -qE "^${key}=" "$env_file"; then
        sed -i "s|^${key}=|# deprecated: ${key}=|" "$env_file"
        echo "[upgrade] merge: deprecated key commented out: $key"
      fi
    done < "$old_tpl"
  fi
  return 0
}

# ── backup into backups/<ts>/ (.env + compose + version + manifest + pg_dump) ──
instance_backup() {
  local instance_dir="$1" ts="$2"
  local dest="$instance_dir/backups/$ts"
  mkdir -p "$dest"
  local f
  for f in .env docker-compose.yml .version .vulnhunter-install.json .vulnagent-install.json; do
    [[ -f "$instance_dir/$f" ]] && cp -p "$instance_dir/$f" "$dest/$f"
  done
  # pg_dump best-effort (data dirs themselves are never moved; dump is extra safety)
  local db_container
  db_container="$(docker ps --format '{{.Names}}' | grep -E '(^|-)db(-1)?$|vulnhunter-db|vulnagent-db' | head -n 1 || true)"
  if [[ -n "$db_container" ]]; then
    if docker exec "$db_container" pg_dump -U vulnhunter vulnhunter > "$dest/pg_dump.sql" 2>/dev/null; then
      echo "[upgrade] backup: pg_dump -> $dest/pg_dump.sql"
    else
      rm -f "$dest/pg_dump.sql"
      echo "[upgrade] warning: pg_dump failed (db container $db_container); file backup kept, data dirs untouched" >&2
    fi
  else
    echo "[upgrade] warning: no running db container found; backup skips pg_dump (data dirs untouched)" >&2
  fi
  echo "[upgrade] backup: $dest"
}

# ── main: upgrade a self-contained instance from a release package ──
run_instance_upgrade() {
  local pkg_root="$1" instance_dir="$2"
  local force="${FORCE:-0}" with_running="${WITH_RUNNING:-0}"

  instance_is_present "$instance_dir" || {
    echo "[upgrade] no self-contained instance at $instance_dir (missing .version)" >&2
    return 1
  }
  if [[ ! -f "$instance_dir/.env" || ! -f "$instance_dir/docker-compose.yml" ]]; then
    echo "[upgrade] instance at $instance_dir is incomplete (need .env + docker-compose.yml) — refusing to touch it" >&2
    return 1
  fi

  local pkg_version installed_version git_commit
  pkg_version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg_root/VERSION.json" 2>/dev/null | head -n 1 || true)"
  git_commit="$(sed -n 's/.*"gitCommit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$pkg_root/VERSION.json" 2>/dev/null | head -n 1 || true)"
  installed_version="$(instance_version_field "$instance_dir" version)"
  echo "[upgrade] instance: $instance_dir (installed=${installed_version:-unknown} -> package=${pkg_version:-unknown})"

  if [[ "$force" != "1" && -n "$pkg_version" && -n "$installed_version" ]]; then
    if semver_lt "$pkg_version" "$installed_version"; then
      echo "[upgrade] package version $pkg_version is older than installed $installed_version — refusing downgrade (FORCE=1 to override)" >&2
      return 1
    fi
  fi

  [[ -f "$pkg_root/.env.example" ]] || { echo "[upgrade] missing .env.example in package" >&2; return 1; }
  [[ -f "$pkg_root/docker-compose.yml" ]] || { echo "[upgrade] missing docker-compose.yml in package" >&2; return 1; }

  # Disk: images*2 + 2GiB headroom
  local images_kb need_kb free_kb
  images_kb="$(du -sk "$pkg_root/images" 2>/dev/null | cut -f1)"
  images_kb="${images_kb:-0}"
  need_kb=$(( images_kb * 2 + 2*1024*1024 ))
  free_kb="$(df -k "$instance_dir" | awk 'NR==2 {print $4}')"
  if [[ -n "$free_kb" ]] && (( free_kb < need_kb )); then
    echo "[upgrade] insufficient disk: need ~$((need_kb/1024))MiB free under $instance_dir, have $((free_kb/1024))MiB" >&2
    return 1
  fi

  # Quiet window (shared gate with legacy upgrade / rename migration)
  if [[ "$with_running" != "1" ]]; then
    # shellcheck disable=SC1091
    source "$pkg_root/lib/rename-migrate.sh"
    rename_quiet_window_gate || return 1
  else
    echo "[upgrade] WITH_RUNNING=1 — skipping worker quiet-window gate" >&2
  fi

  # Verify release checksums (package-local) before touching anything
  if [[ -f "$pkg_root/checksums.sha256" ]]; then
    echo "[upgrade] verifying release files..."
    (cd "$pkg_root" && sha256sum -c checksums.sha256) || return 1
  fi

  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  instance_backup "$instance_dir" "$ts"

  # .env: admin claim (before merge so claim lines count as user values)
  ensure_system_admin_env "$instance_dir/.env"

  # .env: three-way merge, then sync release-owned keys (images / edition / license)
  local real_env="$(readlink -f "$instance_dir/.env")"
  merge_env_three_way "$pkg_root/.env.example" "$instance_dir/.env.template" "$real_env"
  local key value
  for key in SERVICE_IMAGE WEB_IMAGE WORKER_IMAGE POSTGRES_IMAGE MINIO_IMAGE; do
    value="$(grep -E "^${key}=" "$pkg_root/.env.example" | tail -n 1 | cut -d= -f2-)"
    [[ -n "$value" ]] || continue
    if grep -qE "^${key}=" "$real_env"; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$real_env"
    else
      printf '%s=%s\n' "$key" "$value" >> "$real_env"
    fi
    echo "[upgrade] synced release image key: $key=$value"
  done
  # EDITION is a user choice (enterprise pack + EDITION=saas = SaaS). Keep any
  # existing value; only backfill package default when missing (task-09560333).
  local edition pkg_edition
  edition="$(grep -E '^EDITION=' "$real_env" | tail -n 1 | cut -d= -f2- || true)"
  pkg_edition="$(grep -E '^EDITION=' "$pkg_root/.env.example" | tail -n 1 | cut -d= -f2- || true)"
  if [[ -z "$edition" && "$pkg_edition" == "enterprise" ]]; then
    if grep -qE '^EDITION=' "$real_env"; then
      sed -i "s|^EDITION=.*|EDITION=enterprise|" "$real_env"
    else
      printf 'EDITION=enterprise\n' >> "$real_env"
    fi
    echo "[upgrade] backfilled missing EDITION=enterprise"
  elif [[ -n "$edition" ]]; then
    echo "[upgrade] kept user EDITION=$edition"
  fi
  if [[ "$pkg_edition" == "enterprise" ]]; then
    if [[ ! -s "$instance_dir/.secrets/license-public.pem" ]]; then
      echo "[upgrade] enterprise instance missing license public key at $instance_dir/.secrets/license-public.pem" >&2
      return 1
    fi
  fi

  # Replace version-owned files (compose / template / .version / sandbox trio; secrets preserved)
  cp "$pkg_root/docker-compose.yml" "$instance_dir/docker-compose.yml"
  cp "$pkg_root/.env.example" "$instance_dir/.env.template"
  local installed_at
  installed_at="$(sed -n 's/.*"installed_at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$instance_dir/.vulnhunter-install.json" 2>/dev/null | head -n 1 || true)"
  write_version_file "$instance_dir" "$pkg_version" "$git_commit"
  seed_instance_sandbox "$pkg_root" "$instance_dir"
  echo "[upgrade] replaced version-owned files (compose/.env.template/.version/sandbox)"

  # Load new images (parallel, task-55332474), validate, bring stack up.
  # Checksums stay as the existing EARLY gate before any instance mutation —
  # verify-the-package-before-touching-the-instance is untouchable here.
  if [[ -d "$pkg_root/images" ]]; then
    echo "[upgrade] loading images (parallel)..."
    parallel_docker_load "$pkg_root/images" || return 1
  fi
  # shellcheck disable=SC1090
  set -a; source "$instance_dir/.env"; set +a
  validate_local_images || return 1

  # One-time workdir rehome for worker de-identification (probe-gated, no-op on fresh installs)
  rehome_root_owned_workdirs "${DATA_DIR:-$instance_dir/data}" "${SERVICE_UID:-1001}" "${SERVICE_GID:-1001}" "${SERVICE_IMAGE:-vulnhunter-service:latest}"

  local project_name="${PROJECT_NAME:-$(project_name_from_dir "$instance_dir")}"
  echo "[upgrade] restarting stack (project=$project_name)..."
  instance_compose "$instance_dir" "$project_name" up -d --pull never || \
    instance_compose "$instance_dir" "$project_name" up -d --no-build

  # Manifest refresh (reuse install-time shape; preserve installed_at)
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  [[ -n "$installed_at" ]] || installed_at="$now"
  cat > "$instance_dir/.vulnhunter-install.json.tmp" << JSON
{
  "schema_version": 1,
  "product": "vulnhunter",
  "install_dir": "$(json_escape "$instance_dir")",
  "data_dir": "$(json_escape "$instance_dir")",
  "edition": "$(json_escape "${EDITION:-community}")",
  "installed_at": "$(json_escape "$installed_at")",
  "updated_at": "$now",
  "current_version": {
    "version": "$(json_escape "$pkg_version")",
    "git_commit": "$(json_escape "$git_commit")"
  },
  "compose": {
    "file": "docker-compose.yml",
    "network": "vulnhunter-internal",
    "containers": ["vulnhunter-web", "vulnhunter-service", "vulnhunter-db", "vulnhunter-minio"]
  }
}
JSON
  mv "$instance_dir/.vulnhunter-install.json.tmp" "$instance_dir/.vulnhunter-install.json"

  # Doctor (best-effort, from package)
  if [[ -x "$pkg_root/doctor.sh" ]]; then
    echo "[upgrade] running doctor..."
    if INSTANCE_DIR="$instance_dir" "$pkg_root/doctor.sh"; then
      echo "[upgrade] doctor ok"
    else
      echo "[upgrade] warning: doctor reported issues (stack is up; review output above)" >&2
    fi
  fi

  echo ""
  echo "[upgrade] done: ${installed_version:-?} -> ${pkg_version:-?}"
  echo "[upgrade] rollback: backup at $instance_dir/backups/$ts (.env, compose, .version, manifest, pg_dump)"
  echo "[upgrade]   restore: cp backups/$ts/.env backups/$ts/docker-compose.yml $instance_dir/ && docker compose -p $project_name --env-file $instance_dir/.env -f $instance_dir/docker-compose.yml up -d"
  echo "[upgrade]   note: DB migrations are forward-only; cross-version rollback not guaranteed."
}
