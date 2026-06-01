#!/bin/bash
set -e
# Report mode: runs YoungFlow report flow

REPORT_ID="${REPORT_ID:?REPORT_ID is required}"
TASK_ID="${TASK_ID:?TASK_ID is required}"
SERVICE_LOG="/workspace/.service-logs/youngflow.service.jsonl"

finish_log() {
  mkdir -p /workspace/out/.youngflow/logs
  if [ -f "$SERVICE_LOG" ]; then
    cp "$SERVICE_LOG" /workspace/out/.youngflow/logs/youngflow.service.jsonl
  fi
}

trap finish_log EXIT

echo "[report] Starting report worker: task=$TASK_ID report=$REPORT_ID"

FLOW_DIR="/opt/vulnagent/flows/vulnagent-report"

mkdir -p /workspace/reports /workspace/context

# Copy flow to workspace so we can inject uploaded skill
cp -r "$FLOW_DIR" /workspace/flow
FLOW_DIR="/workspace/flow"

# If uploaded skill exists, copy into flow skills directory
if [ -d "/workspace/skill" ] && [ -f "/workspace/skill/SKILL.md" ]; then
  echo "[report] Injecting uploaded Report Skill"
  cp -r /workspace/skill "$FLOW_DIR/skills/uploaded-report-skill"
elif [ -d "/workspace/skill" ]; then
  # Check one level deeper (zip may have a subdirectory)
  SKILL_DIR=$(find /workspace/skill -maxdepth 2 -name "SKILL.md" -exec dirname {} \; | head -1)
  if [ -n "$SKILL_DIR" ]; then
    echo "[report] Injecting uploaded Report Skill from $SKILL_DIR"
    cp -r "$SKILL_DIR" "$FLOW_DIR/skills/uploaded-report-skill"
  fi
fi

# Write .env for youngflow model config
cat > "$FLOW_DIR/.env" << ENVEOF
LLM_MODEL_NAME=${LLM_MODEL_NAME:-}
LLM_BASE_URL=${LLM_BASE_URL:-}
LLM_API_KEY=${LLM_API_KEY:-}
MODEL_PROTO_TYPE=${MODEL_PROTO_TYPE:-openai}
MODEL_EFFORT=${MODEL_EFFORT:-medium}
LLM_CONTEXT_WINDOW_TOKENS=${LLM_CONTEXT_WINDOW_TOKENS:-128000}
YOUNGFLOW_IDLE_TIMEOUT=${YOUNGFLOW_IDLE_TIMEOUT:-3600}
YOUNGFLOW_ERROR_RETRIES=${YOUNGFLOW_ERROR_RETRIES:-5}
ENVEOF

mkdir -p /workspace/.service-logs
rm -f "$SERVICE_LOG"

echo "[report] Running youngflow report flow..." >&2
set +e
youngflow "$FLOW_DIR" \
  --work-dir /workspace \
  --output-dir /workspace/out \
  --task-id "$TASK_ID" \
  --report-id "$REPORT_ID" \
  --context-file "/workspace/context/report-context.json" \
  --reports-dir "/workspace/reports" \
  --json-log \
  2>"$SERVICE_LOG"
EXIT=$?
set -e

finish_log
trap - EXIT

echo "[report] Done (exit=$EXIT)" >&2
exit $EXIT
