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
