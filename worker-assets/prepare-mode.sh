#!/bin/sh
set -eu
umask 077
export PATH=/usr/local/bin:/usr/bin:/bin

: "${PREPARE_SOURCE_ROOT:?}"
: "${PREPARE_CONTROL_DIR:?}"
: "${PREPARE_OUTPUT_DIR:?}"
: "${PREPARE_PLANNER_INPUT:?}"
: "${PREPARE_MANIFEST_SCHEMA:?}"
: "${PREPARE_PLAN_SCHEMA:?}"

# Ownership linearizes at the owner mkdir. Before it succeeds, inspect only
# the control path type; never follow a symlink or mutate existing run state.
if [ -L "$PREPARE_CONTROL_DIR" ]; then
  echo "[prepare] control directory cannot be a symlink" >&2
  exit 3
elif [ -e "$PREPARE_CONTROL_DIR" ]; then
  [ -d "$PREPARE_CONTROL_DIR" ] || { echo "[prepare] invalid control directory" >&2; exit 3; }
else
  mkdir "$PREPARE_CONTROL_DIR" || exit 3
fi
[ -d "$PREPARE_CONTROL_DIR" ] && [ ! -L "$PREPARE_CONTROL_DIR" ] || exit 3
owner_dir="$PREPARE_CONTROL_DIR/.prepare-owner"
if ! mkdir "$owner_dir" 2>/dev/null; then
  echo "[prepare] active owner already holds control/output; refusing to start" >&2
  exit 3
fi

owner_id="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || true)"
case "$owner_id" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) rmdir "$owner_dir" 2>/dev/null || true; exit 3 ;;
esac
identity="$owner_dir/identity"
identity_tmp="$owner_dir/identity.tmp"
if ! (set -C; printf '%s\n' "$owner_id" > "$identity_tmp") 2>/dev/null \
  || ! chmod 600 "$identity_tmp" \
  || ! mv "$identity_tmp" "$identity"; then
  rm -f "$identity_tmp" 2>/dev/null || true
  rmdir "$owner_dir" 2>/dev/null || true
  exit 3
fi

owns_run() {
  [ -d "$owner_dir" ] && [ ! -L "$owner_dir" ] \
    && [ -f "$identity" ] && [ ! -L "$identity" ] \
    && [ "$(stat -c %a "$identity" 2>/dev/null || true)" = "600" ] \
    && [ "$(wc -c < "$identity" 2>/dev/null || true)" = "37" ] \
    && [ "$(cat "$identity" 2>/dev/null || true)" = "$owner_id" ]
}
release_marker_only() {
  owns_run || return 1
  rm -f "$identity" || return 1
  rmdir "$owner_dir" || return 1
}
if ! owns_run; then
  rm -f "$identity_tmp" "$identity" 2>/dev/null || true
  rmdir "$owner_dir" 2>/dev/null || true
  exit 3
fi

# A free marker never grants ownership over artifacts from a previous run.
# The planner input must be the sole pre-existing control entry.
preexisting=""
if [ "$(dirname -- "$PREPARE_PLANNER_INPUT")" != "$PREPARE_CONTROL_DIR" ] \
  || [ ! -f "$PREPARE_PLANNER_INPUT" ] || [ -L "$PREPARE_PLANNER_INPUT" ]; then
  preexisting="planner_input"
else
  preexisting="$(find "$PREPARE_CONTROL_DIR" -mindepth 1 -maxdepth 1 \
    ! -path "$owner_dir" ! -path "$PREPARE_PLANNER_INPUT" -print -quit 2>/dev/null || true)"
fi
if [ -z "$preexisting" ] && { [ -e "$PREPARE_OUTPUT_DIR" ] || [ -L "$PREPARE_OUTPUT_DIR" ]; }; then
  if [ ! -d "$PREPARE_OUTPUT_DIR" ] || [ -L "$PREPARE_OUTPUT_DIR" ]; then
    preexisting="output_type"
  else
    preexisting="$(find "$PREPARE_OUTPUT_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)"
  fi
fi
if [ -n "$preexisting" ]; then
  release_marker_only || true
  echo "[prepare] pre-existing run state; refusing to start" >&2
  exit 3
fi

child=""
cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  cd /
  if ! owns_run; then
    [ "$rc" -ne 0 ] || rc=3
    exit "$rc"
  fi
  if [ "$rc" -ne 0 ]; then
    find "$PREPARE_OUTPUT_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
  fi
  if ! owns_run; then
    [ "$rc" -ne 0 ] || rc=3
    exit "$rc"
  fi
  find "$PREPARE_CONTROL_DIR" -mindepth 1 -maxdepth 1 ! -path "$owner_dir" -exec rm -rf -- {} + 2>/dev/null || true
  if ! owns_run; then
    [ "$rc" -ne 0 ] || rc=3
    exit "$rc"
  fi
  rm -f "$identity" || { [ "$rc" -ne 0 ] || rc=3; exit "$rc"; }
  rmdir "$owner_dir" || { [ "$rc" -ne 0 ] || rc=3; exit "$rc"; }
  exit "$rc"
}
terminate() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    child=""
  fi
}
# Destructive cleanup is installed only after identity commit and pristine gate.
trap cleanup EXIT
trap terminate INT TERM HUP

# Initialization after the pristine gate is owner-bound: any failure now
# executes matching cleanup instead of leaking an owner marker.
mkdir -p "$PREPARE_OUTPUT_DIR"
chmod 700 "$PREPARE_CONTROL_DIR" "$PREPARE_OUTPUT_DIR"

probe="$PREPARE_SOURCE_ROOT/.prepare-readonly-probe-$$"
if (umask 077 && : > "$probe") 2>/dev/null; then
  rm -f "$probe"
  echo "[prepare] source mount is writable; refusing to start" >&2
  exit 3
fi

cd "$PREPARE_CONTROL_DIR"
youngflow /opt/vulnagent/flows/prepare/flow.prepare.yaml &
child=$!
wait "$child"
child=""
