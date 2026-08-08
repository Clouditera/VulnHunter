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

FLOW_DIR="/opt/vulnhunter/flows/vulnhunter-report"

mkdir -p /workspace/reports /workspace/context/findings /workspace/context/wiki /workspace/context/poc /workspace/context/reviewed

# Copy flow to workspace so we can inject uploaded skill
cp -r "$FLOW_DIR" /workspace/flow
FLOW_DIR="/workspace/flow"

# If uploaded skill exists, copy into flow skills directory; else fall back to builtin default.
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

if [ ! -d "$FLOW_DIR/skills/uploaded-report-skill" ]; then
  if [ -d "$FLOW_DIR/skills/default-report-skill" ]; then
    echo "[report] No uploaded skill — using builtin default-report-skill"
    cp -r "$FLOW_DIR/skills/default-report-skill" "$FLOW_DIR/skills/uploaded-report-skill"
  else
    echo "[report] FATAL: no uploaded skill and default-report-skill missing from image" >&2
    exit 1
  fi
fi
# ---------------------------------------------------------------------------
# Model config: consume pre-generated models.json from the unified module.
#
# Batch 2 (fish 2026-08-08): the service pre-generates models.json via
# buildModelsJson (credential-models.ts) and writes it to
# /workspace/.pi-agent/models.json + model-env.json before the worker starts.
# ---------------------------------------------------------------------------
PI_AGENT_SRC="/workspace/.pi-agent"

if [ ! -f "$PI_AGENT_SRC/models.json" ]; then
  echo "[report] FATAL: pre-generated models.json not found at $PI_AGENT_SRC/models.json. The service must generate it before starting the worker." >&2
  exit 1
fi
if [ ! -f "$PI_AGENT_SRC/model-env.json" ]; then
  echo "[report] FATAL: pre-generated model-env.json not found at $PI_AGENT_SRC/model-env.json." >&2
  exit 1
fi

# Copy models.json into the flow directory
cp "$PI_AGENT_SRC/models.json" "$FLOW_DIR/models.json"

# Extract V_DEFAULT_MODEL from model-env.json (written by the service)
V_DEFAULT_MODEL="$(python3 -c "import json; print(json.load(open('$PI_AGENT_SRC/model-env.json'))['vDefaultModel'])" 2>/dev/null || echo '')"
if [ -z "$V_DEFAULT_MODEL" ]; then
  echo "[report] FATAL: failed to read vDefaultModel from model-env.json" >&2
  exit 1
fi

cat > "$FLOW_DIR/.env" << ENVEOF
V_DEFAULT_MODEL=${V_DEFAULT_MODEL}
YOUNGFLOW_IDLE_TIMEOUT=${YOUNGFLOW_IDLE_TIMEOUT:-3600}
YOUNGFLOW_ERROR_RETRIES=${YOUNGFLOW_ERROR_RETRIES:-5}
ENVEOF

echo "[report] Copied pre-generated models.json + wrote .env (model=$V_DEFAULT_MODEL)" >&2
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
