#!/bin/bash
set -e
# Report mode: runs YoungFlow report flow

REPORT_ID="${REPORT_ID:?REPORT_ID is required}"
TASK_ID="${TASK_ID:?TASK_ID is required}"

echo "[report] Starting report worker: task=$TASK_ID report=$REPORT_ID"

FLOW_DIR="/opt/vulnhunt/flows/vulnhunt-report"
WORK_DIR="/workspace"
OUT_DIR="/workspace/out"

mkdir -p /workspace/reports /workspace/context "$OUT_DIR"

# Copy flow to workspace so we can inject uploaded skill
cp -r "$FLOW_DIR" /workspace/flow

# If uploaded skill exists, copy into flow skills directory
if [ -d "/workspace/skill" ] && [ -f "/workspace/skill/SKILL.md" ]; then
  echo "[report] Injecting uploaded Report Skill"
  cp -r /workspace/skill /workspace/flow/skills/uploaded-report-skill
elif [ -d "/workspace/skill" ]; then
  # Check one level deeper (zip may have a subdirectory)
  SKILL_DIR=$(find /workspace/skill -maxdepth 2 -name "SKILL.md" -exec dirname {} \; | head -1)
  if [ -n "$SKILL_DIR" ]; then
    echo "[report] Injecting uploaded Report Skill from $SKILL_DIR"
    cp -r "$SKILL_DIR" /workspace/flow/skills/uploaded-report-skill
  fi
fi

# Persist env vars for youngflow subprocesses
cat >> ~/.bashrc << ENVEOF
export LLM_MODEL_NAME=${LLM_MODEL_NAME:-}
export LLM_BASE_URL=${LLM_BASE_URL:-}
export LLM_API_KEY=${LLM_API_KEY:-}
export MODEL_PROTO_TYPE=${MODEL_PROTO_TYPE:-openai}
ENVEOF

echo "[report] Running youngflow report flow..." >&2
youngflow /workspace/flow \
  --work-dir "$WORK_DIR" \
  --output-dir "$OUT_DIR" \
  --input task_id="$TASK_ID" \
  --input report_id="$REPORT_ID" \
  --input context_file="/workspace/context/report-context.json" \
  --input reports_dir="/workspace/reports" \
  --json-log \
  2>&1

echo "[report] YoungFlow report flow completed" >&2
