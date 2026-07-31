#!/usr/bin/env bash
# Shared helpers for self-contained INSTANCE_DIR layout (design v1.0 batch 1).
# shellcheck shell=bash

# Default instance root (= DATA_DIR).
INSTANCE_DIR_DEFAULT="${INSTANCE_DIR_DEFAULT:-/opt/vulnhunter/data}"

# Derive a stable compose project name from a directory basename.
# Example: /opt/vulnhunter/data → vulnhunter-data
project_name_from_dir() {
  local dir base cleaned
  dir="${1:-}"
  base="$(basename "$dir")"
  cleaned="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')"
  if [[ -z "$cleaned" ]]; then
    cleaned="vulnhunter"
  fi
  # Prefer vulnhunter- prefix when basename is generic "data"
  if [[ "$cleaned" == "data" ]]; then
    printf 'vulnhunter-data\n'
  else
    printf 'vulnhunter-%s\n' "$cleaned"
  fi
}

# Write .version JSON into INSTANCE_DIR.
# Args: instance_dir version git_commit [installed_at_iso]
write_version_file() {
  local instance_dir="$1"
  local version="${2:-}"
  local git_commit="${3:-}"
  local installed_at="${4:-}"
  if [[ -z "$installed_at" ]]; then
    installed_at="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  fi
  mkdir -p "$instance_dir"
  cat >"$instance_dir/.version" <<EOF
{
  "version": "$(printf '%s' "$version" | sed 's/"/\\"/g')",
  "gitCommit": "$(printf '%s' "$git_commit" | sed 's/"/\\"/g')",
  "installedAt": "$installed_at"
}
EOF
}

# True if INSTANCE_DIR looks like a self-contained instance (has .version).
instance_is_present() {
  local instance_dir="$1"
  [[ -f "$instance_dir/.version" ]]
}

# Read a field from INSTANCE_DIR/.version (best-effort sed).
instance_version_field() {
  local instance_dir="$1"
  local key="$2"
  [[ -f "$instance_dir/.version" ]] || return 0
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$instance_dir/.version" | head -n 1
}

# Compose wrapper bound to an instance directory.
# Usage: instance_compose "$INSTANCE_DIR" "$PROJECT_NAME" <compose args...>
instance_compose() {
  local instance_dir="$1"
  local project_name="$2"
  shift 2
  local env_file="$instance_dir/.env"
  local compose_file="$instance_dir/docker-compose.yml"
  if [[ ! -f "$env_file" ]]; then
    echo "[instance] missing $env_file" >&2
    return 1
  fi
  if [[ ! -f "$compose_file" ]]; then
    echo "[instance] missing $compose_file" >&2
    return 1
  fi
  if docker compose version >/dev/null 2>&1; then
    docker compose -p "$project_name" --env-file "$env_file" -f "$compose_file" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -p "$project_name" --env-file "$env_file" -f "$compose_file" "$@"
  else
    echo "[instance] Docker Compose is required" >&2
    return 127
  fi
}

# Seed instance-owned sandbox version files from package sandbox/ (no images, no secrets).
# Secrets stay empty until sandbox/install.sh runs.
seed_instance_sandbox() {
  local pkg_root="$1"
  local instance_dir="$2"
  local src="$pkg_root/sandbox"
  local dst="$instance_dir/sandbox"
  [[ -d "$src" ]] || return 0
  mkdir -p "$dst"
  local f
  for f in docker-compose.yml config.yaml profiles.yaml; do
    if [[ -f "$src/$f" ]]; then
      cp -f "$src/$f" "$dst/$f"
    fi
  done
  # keep install/upgrade helpers available after package delete
  for f in install.sh upgrade.sh; do
    if [[ -f "$src/$f" ]]; then
      cp -f "$src/$f" "$dst/$f"
      chmod +x "$dst/$f" 2>/dev/null || true
    fi
  done
  mkdir -p "$dst/secrets"
  chmod 700 "$dst/secrets" 2>/dev/null || true
}
