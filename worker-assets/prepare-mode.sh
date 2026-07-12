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

mkdir -p "$PREPARE_CONTROL_DIR" "$PREPARE_OUTPUT_DIR"
chmod 700 "$PREPARE_CONTROL_DIR" "$PREPARE_OUTPUT_DIR"
owner_dir="$PREPARE_CONTROL_DIR/.prepare-owner"
if ! mkdir "$owner_dir" 2>/dev/null; then
  echo "[prepare] active owner already holds control/output; refusing to start" >&2
  exit 3
fi
child=""
cleanup() {
  rc=$?
  trap - EXIT INT TERM HUP
  cd /
  if [ "$rc" -ne 0 ]; then
    find "$PREPARE_OUTPUT_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
  fi
  find "$PREPARE_CONTROL_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
  exit "$rc"
}
terminate() {
  [ -z "$child" ] || kill -TERM "$child" 2>/dev/null || true
}
# Install destructive cleanup only after this process atomically owns the run.
# A competing process that failed mkdir above must never clean the active owner.
trap cleanup EXIT
trap terminate INT TERM HUP

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
