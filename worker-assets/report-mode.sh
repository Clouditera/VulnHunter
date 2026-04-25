#!/bin/bash
set -e
# Report mode: runs YoungFlow report flow

REPORT_ID="${REPORT_ID:?REPORT_ID is required}"
TASK_ID="${TASK_ID:?TASK_ID is required}"

echo "[report] Starting report worker: task=$TASK_ID report=$REPORT_ID"

FLOW_DIR="/opt/vulnhunt/flows/vulnhunt-report"

mkdir -p /workspace/reports /workspace/context /workspace/out/.youngflow/logs

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
ENVEOF

echo "[report] Running youngflow report flow..." >&2
youngflow "$FLOW_DIR" \
  --work-dir /workspace \
  --output-dir /workspace/out \
  --task-id "$TASK_ID" \
  --report-id "$REPORT_ID" \
  --context-file "/workspace/context/report-context.json" \
  --reports-dir "/workspace/reports" \
  --json-log \
  2>/workspace/out/.youngflow/logs/youngflow.service.jsonl

EXIT=$?
echo "[report] Done (exit=$EXIT)" >&2
exit $EXIT
