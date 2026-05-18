#!/bin/bash
set -euo pipefail

: "${TASK_ID:?TASK_ID is required}"
: "${POC_JOB_ID:?POC_JOB_ID is required}"

FLOW_DIR="/opt/vulnhunt/flows/vulnhunt-poc"

echo "[eval] Starting POC generation: task=$TASK_ID job=$POC_JOB_ID" >&2

mkdir -p /workspace/out/.youngflow/logs

# Write .env for youngflow model config
cat > "$FLOW_DIR/.env" << EOF
MODEL_PROTO_TYPE=${MODEL_PROTO_TYPE:-openai}
LLM_MODEL_NAME=${LLM_MODEL_NAME:-}
LLM_BASE_URL=${LLM_BASE_URL:-}
LLM_API_KEY=${LLM_API_KEY:-}
MODEL_EFFORT=${MODEL_EFFORT:-medium}
LLM_CONTEXT_WINDOW_TOKENS=${LLM_CONTEXT_WINDOW_TOKENS:-128000}
YOUNGFLOW_IDLE_TIMEOUT=${YOUNGFLOW_IDLE_TIMEOUT:-3600}
YOUNGFLOW_ERROR_RETRIES=${YOUNGFLOW_ERROR_RETRIES:-5}
DEVEYE_SERVER=${DEVEYE_SERVER:-}
DEVEYE_TOKEN=${DEVEYE_TOKEN:-}
EOF

# Install DeVeye CLI if binary exists in skills
if [ -f "$FLOW_DIR/skills/deveye/bin/deveye" ]; then
  cp "$FLOW_DIR/skills/deveye/bin/deveye" /usr/local/bin/deveye
  chmod +x /usr/local/bin/deveye
  echo "[eval] DeVeye CLI installed" >&2
fi

# Persist DeVeye env vars for subprocesses
if [ -n "${DEVEYE_SERVER:-}" ]; then
  cat >> ~/.bashrc << ENVEOF
export DEVEYE_SERVER=${DEVEYE_SERVER}
export DEVEYE_TOKEN=${DEVEYE_TOKEN:-}
ENVEOF
fi

echo "[eval] Running youngflow POC flow (target_mode=$TARGET_MODE)..." >&2
youngflow "$FLOW_DIR" \
  --work-dir /workspace/subject \
  --output-dir /workspace/out \
  --target-mode "${TARGET_MODE:-provided}" \
  ${TARGET_URL:+--target-url "${TARGET_URL}"} \
  ${BROWSER_TOOL:+--browser-tool "${BROWSER_TOOL}"} \
  ${CUSTOM_INSTRUCTIONS:+--custom-instructions "${CUSTOM_INSTRUCTIONS}"} \
  --json-log \
  $([ "$RESUME" = "1" ] && echo "--resume") \
  2>/workspace/out/.youngflow/logs/youngflow.service.jsonl

EXIT=$?

echo "[eval] Done (exit=$EXIT)" >&2
exit $EXIT
