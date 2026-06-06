#!/bin/bash
set -e

TASK_ID="${TASK_ID:?TASK_ID is required}"
FLOW_DIR="/opt/vulnagent/flows/vulnforge"
FLOW_FILE="$FLOW_DIR/flow.deep.yaml"
SERVICE_LOG="/workspace/.service-logs/youngflow.service.jsonl"

finish_log() {
  mkdir -p /workspace/out/.youngflow/logs
  if [ -f "$SERVICE_LOG" ]; then
    cp "$SERVICE_LOG" /workspace/out/.youngflow/logs/youngflow.service.jsonl
  fi
}

trap finish_log EXIT

echo "[scan] Starting scan for task: $TASK_ID" >&2

# Preflight: verify critical dependencies
if ! command -v python3 &>/dev/null; then
  echo "[scan] FATAL: python3 not found — VulnForge helpers require python3" >&2
  exit 1
fi
if ! python3 -c "import yaml" 2>/dev/null; then
  echo "[scan] FATAL: python3-yaml not installed — VulnForge helpers require pyyaml" >&2
  exit 1
fi
if [ ! -f "$FLOW_FILE" ]; then
  echo "[scan] FATAL: VulnForge flow not found: $FLOW_FILE" >&2
  exit 1
fi
echo "[scan] Preflight OK: python3 + yaml + VulnForge flow available" >&2

# Code already extracted to /workspace/src/ by service (bind mount)

# Write .env for youngflow model config (reads from flow dir .env, not process.env)
cat > "$FLOW_DIR/.env" << EOF
MODEL_PROTO_TYPE=${MODEL_PROTO_TYPE:-openai}
LLM_MODEL_NAME=${LLM_MODEL_NAME:-}
LLM_BASE_URL=${LLM_BASE_URL:-}
LLM_API_KEY=${LLM_API_KEY:-}
MODEL_EFFORT=${MODEL_EFFORT:-medium}
LLM_CONTEXT_WINDOW_TOKENS=${LLM_CONTEXT_WINDOW_TOKENS:-128000}
YOUNGFLOW_IDLE_TIMEOUT=${YOUNGFLOW_IDLE_TIMEOUT:-3600}
YOUNGFLOW_ERROR_RETRIES=${YOUNGFLOW_ERROR_RETRIES:-5}
EOF

if [ "${RESUME:-0}" != "1" ] && [ "${CONTINUE:-0}" != "1" ]; then
  rm -rf /workspace/out
fi
mkdir -p /workspace/.service-logs
rm -f "$SERVICE_LOG"

YOUNGFLOW_MAX_PARALLEL=${YOUNGFLOW_MAX_PARALLEL:-3}
YOUNGFLOW_ARGS=(
  "$FLOW_FILE"
  --work-dir /workspace/src
  --output-dir /workspace/out
  --json-log
  --max-parallel "$YOUNGFLOW_MAX_PARALLEL"
)

# Optional: stop after a specific stage (debug/Phase 0). Scan-duration
# termination is handled by the `timeout` wrapper below, NOT --until
# (YoungFlow --until only accepts a known stage id).
if [ -n "${UNTIL:-}" ]; then
  YOUNGFLOW_ARGS+=(--until "$UNTIL")
fi
if [ -n "${RECURSION_LIMIT:-}" ]; then
  YOUNGFLOW_ARGS+=(--recursion-limit "$RECURSION_LIMIT")
fi
if [ -n "${AUDIT_FOCUS:-}" ]; then
  YOUNGFLOW_ARGS+=(--audit-focus "$AUDIT_FOCUS")
fi
if [ -n "${MAX_ITEMS_PER_RECON:-}" ]; then
  YOUNGFLOW_ARGS+=(--max-items-per-recon "$MAX_ITEMS_PER_RECON")
fi
if [ "${RESUME:-0}" = "1" ]; then
  YOUNGFLOW_ARGS+=(--resume)
fi
if [ "${CONTINUE:-0}" = "1" ]; then
  YOUNGFLOW_ARGS+=(--continue)
fi

# Scan-duration termination: wrap youngflow in coreutils `timeout`.
# SCAN_TIMEOUT (seconds) bounds the whole scan; when it elapses youngflow
# gets SIGTERM to clean up, and we treat that as a normal completion so the
# scheduler still syncs outputs + indexes findings. Falls back to the flow's
# own 60h timeout when SCAN_TIMEOUT is unset.
EFFECTIVE_TIMEOUT="${SCAN_TIMEOUT:-216000}"

echo "[scan] Running youngflow (version=$(youngflow --version), model=$LLM_MODEL_NAME, max_parallel=$YOUNGFLOW_MAX_PARALLEL, timeout=${EFFECTIVE_TIMEOUT}s, flow=$FLOW_FILE)..." >&2
set +e
timeout --signal=TERM --kill-after=30 "${EFFECTIVE_TIMEOUT}s" \
  youngflow "${YOUNGFLOW_ARGS[@]}" 2>"$SERVICE_LOG"
EXIT=$?
set -e

# timeout returns 124 (TERM) or 137 (KILL after --kill-after) when the scan
# duration cap is hit. That is an expected, successful Phase-0 termination:
# normalize to 0 so the scheduler runs sync + index on the produced findings.
if [ "$EXIT" = "124" ] || [ "$EXIT" = "137" ]; then
  echo "[scan] Scan stopped after ${EFFECTIVE_TIMEOUT}s scan-duration cap (normal termination)" >&2
  EXIT=0
fi

finish_log
trap - EXIT

echo "[scan] Done (exit=$EXIT)" >&2
exit $EXIT
