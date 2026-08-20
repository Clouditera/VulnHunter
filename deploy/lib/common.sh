#!/usr/bin/env bash
# Shared shell helpers for deploy scripts.
# shellcheck shell=bash

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    echo "[deploy] Docker Compose is required: install Docker Compose v2 ('docker compose') or legacy docker-compose" >&2
    return 127
  fi
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  printf '%s' "$s"
}

# ── Release image helpers (shared by upgrade.sh + instance upgrade) ──
image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}
required_images() {
  printf '%s\n' \
    "${SERVICE_IMAGE:-vulnhunter-service:latest}" \
    "${WEB_IMAGE:-vulnhunter-web:latest}" \
    "${WORKER_IMAGE:-vulnhunter-worker:latest}" \
    "${POSTGRES_IMAGE:-postgres:16-alpine}" \
    "${MINIO_IMAGE:-minio/minio:RELEASE.2025-09-07T16-13-09Z}" \
    | awk 'NF && !seen[$0]++'
}
validate_local_images() {
  local missing=()
  while IFS= read -r image; do
    [[ -n "$image" ]] || continue
    if ! image_exists "$image"; then
      missing+=("$image")
    fi
  done < <(required_images)
  if (( ${#missing[@]} > 0 )); then
    echo "[upgrade] required Docker images are missing locally; refusing to contact external registries." >&2
    printf '[upgrade] missing image: %s\n' "${missing[@]}" >&2
    echo "[upgrade] Ensure the offline release images/*.tar files are present and rerun the installer/upgrader." >&2
    return 1
  fi
  return 0
}

# ── System admin env claim (shared by upgrade.sh + instance upgrade) ─
# Adopt the existing admin's email from the running DB; never invent a
# password (password line appended commented). Usage: ensure_system_admin_env <envfile>
discover_admin_email() {
  local db_container
  db_container="$(docker ps --format '{{.Names}}' | grep -E '(^|-)db$|vulnhunter-db|vulnagent-db' | head -n 1 || true)"
  [[ -n "$db_container" ]] || return 0
  docker exec "$db_container" psql -U vulnhunter -d vulnhunter -tAc \
    "SELECT email FROM users WHERE role='admin' ORDER BY created_at LIMIT 1" 2>/dev/null | head -n 1 || true
}
# ── Host DMI product UUID capture (HALL-12) ──────────────────────────
# Copy /sys/class/dmi/id/product_uuid into OUT_FILE (normalized lowercase,
# validated); write an empty file when unavailable/unreadable/invalid so the
# compose bind-mount source always exists and the service falls back to the
# legacy .install_id behavior. Usage: capture_host_dmi_product_uuid <out_file>
capture_host_dmi_product_uuid() {
  local out_file="$1" raw norm
  raw="$(cat /sys/class/dmi/id/product_uuid 2>/dev/null || true)"
  norm="$(printf '%s' "$raw" | tr 'A-F' 'a-f' | tr -d '[:space:]')"
  if [[ "$norm" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    && [[ "$norm" != "00000000-0000-0000-0000-000000000000" ]]; then
    printf '%s\n' "$norm" > "$out_file"
    chmod 0444 "$out_file" 2>/dev/null || true
    return 0
  fi
  : > "$out_file"
  chmod 0444 "$out_file" 2>/dev/null || true
  return 1
}

ensure_system_admin_env() {
  local env_file="${1:-.env}"
  [[ -f "$env_file" ]] || return 0
  if ! grep -qE '^VULNHUNTER_ADMIN_EMAIL=' "$env_file"; then
    local admin_email
    admin_email="$(discover_admin_email || true)"
    if [[ -n "$admin_email" ]]; then
      printf 'VULNHUNTER_ADMIN_EMAIL=%s\n' "$admin_email" >> "$env_file"
      echo "[upgrade] system admin email adopted from existing admin: $admin_email"
    else
      printf '# VULNHUNTER_ADMIN_EMAIL=admin@example.com\n' >> "$env_file"
      echo "[upgrade] NOTE: no admin email discoverable; set VULNHUNTER_ADMIN_EMAIL in $env_file"
    fi
  fi
  if ! grep -qE '^VULNHUNTER_ADMIN_PASSWORD=' "$env_file"; then
    printf '# VULNHUNTER_ADMIN_PASSWORD=set-a-strong-password-here\n' >> "$env_file"
    echo "[upgrade] NOTE: set VULNHUNTER_ADMIN_PASSWORD in $env_file and restart to activate protected system admin (cannot be disabled/deleted)"
  fi
}

# Worker de-identification (fish-approved 2026-08-05): workers now run as
# SERVICE_UID, so legacy root-written files in task workspaces would wedge
# continue-scan / cleanup. One-shot root helper chowns the worker-writable
# data dirs. Probe first (fresh installs skip at zero cost); db/minio are
# NEVER touched (postgres/minio uids). Rollback-safe: old root workers can
# still write the chowned dirs.
rehome_root_owned_workdirs() {
  local data_dir="$1" uid="$2" gid="$3" image="$4"
  local dirs=(workspaces chat-sessions report-workspaces diagnostics)
  local d
  for d in "${dirs[@]}"; do
    [[ -d "$data_dir/$d" ]] || continue
    if find "$data_dir/$d" -uid 0 -print -quit 2>/dev/null | grep -q .; then
      echo "[upgrade] root-owned files found under $data_dir/$d — rehoming workdirs to $uid:$gid (worker de-identification)..."
      docker run --rm --user 0:0 -v "$data_dir:/data" --entrypoint sh "$image" -c         "for d in ${dirs[*]}; do [ -d /data/\$d ] && chown -R $uid:$gid /data/\$d; done; echo rehomed"         && echo "[upgrade] workdir rehome done (${dirs[*]})"         || echo "[upgrade] warning: workdir rehome failed — legacy tasks may hit permission errors" >&2
      return 0
    fi
  done
  echo "[upgrade] workdir ownership: no root-owned files — rehome skipped"
}

# Parallel docker load (task-55332474): concurrent 'docker load -i' for every
# *.tar in DIR. Images have no inter-dependencies and the daemon serializes
# its own writes, so parallel load is safe; on a 5-image pack this cuts the
# install's biggest serial block (~88s → ~30-40s). Per-tar ok/FAILED lines;
# failed loads print full output. Returns 1 if any load failed.
parallel_docker_load() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  local -a tars=()
  local f pids=() fail=0
  shopt -s nullglob
  for f in "$dir"/*.tar; do tars+=("$f"); done
  shopt -u nullglob
  [[ ${#tars[@]} -gt 0 ]] || return 0
  local tmpdir
  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/docker-load.XXXXXX")"
  for f in "${tars[@]}"; do
    local base out
    base="$(basename "$f")"
    out="$tmpdir/${base}.log"
    ( docker load -i "$f" >"$out" 2>&1 ) &
    pids+=($!)
  done
  local i
  for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then
      echo "[load] ok: $(basename "${tars[$i]}")"
    else
      echo "[load] FAILED: $(basename "${tars[$i]}")" >&2
      cat "$tmpdir/$(basename "${tars[$i]}").log" >&2
      fail=1
    fi
  done
  rm -rf "$tmpdir"
  return $fail
}
