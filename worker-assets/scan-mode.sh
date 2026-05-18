#!/bin/bash
set -e

TASK_ID="${TASK_ID:?TASK_ID is required}"
FLOW_DIR="/opt/vulnhunt/flows/vulnhunt"

echo "[scan] Starting scan for task: $TASK_ID" >&2

# Preflight: verify critical dependencies
if ! command -v python3 &>/dev/null; then
  echo "[scan] FATAL: python3 not found — feature-aggregator requires python3" >&2
  exit 1
fi
if ! python3 -c "import yaml" 2>/dev/null; then
  echo "[scan] FATAL: python3-yaml not installed — feature-aggregator requires pyyaml" >&2
  exit 1
fi
echo "[scan] Preflight OK: python3 + yaml available" >&2

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

mkdir -p /workspace/out/.youngflow/logs

echo "[scan] Running youngflow (model=$LLM_MODEL_NAME)..." >&2
youngflow "$FLOW_DIR" \
  --work-dir /workspace/src \
  --output-dir /workspace/out \
  --json-log \
  ${UNTIL:+--until "$UNTIL"} \
  $([ "$RESUME" = "1" ] && echo "--resume") \
  2>/workspace/out/.youngflow/logs/youngflow.service.jsonl

EXIT=$?

echo "[scan] Done (exit=$EXIT)" >&2
exit $EXIT
