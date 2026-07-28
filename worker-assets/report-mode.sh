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
# Model config for YoungFlow 0.3.x / pi 0.79.x.
#
# Report mode is independent from scan-mode and also needs pi-native
# models.json. YoungFlow 0.3.x does not translate the legacy flat LLM_* env
# vars into pi config; the flow declares `artifacts.models_json: models.json`
# and resolves its model through `${env.V_DEFAULT_MODEL}`.
# ---------------------------------------------------------------------------
if ! command -v python3 &>/dev/null; then
  echo "[report] FATAL: python3 not found — required for models.json generation" >&2
  exit 1
fi

MODEL_PROTO_TYPE="${MODEL_PROTO_TYPE:-openai-completions}"
LLM_MODEL_NAME="${LLM_MODEL_NAME:-}"
LLM_BASE_URL="${LLM_BASE_URL:-}"
LLM_API_KEY="${LLM_API_KEY:-}"
MODEL_EFFORT="${MODEL_EFFORT:-off}"
LLM_CONTEXT_WINDOW_TOKENS="${LLM_CONTEXT_WINDOW_TOKENS:-128000}"

if [ -z "$LLM_MODEL_NAME" ] || [ -z "$LLM_API_KEY" ]; then
  echo "[report] FATAL: model credential not configured (LLM_MODEL_NAME / LLM_API_KEY missing). Configure a model in Settings before generating reports." >&2
  exit 1
fi

V_DEFAULT_MODEL="$(
  MODEL_PROTO_TYPE="$MODEL_PROTO_TYPE" \
  LLM_MODEL_NAME="$LLM_MODEL_NAME" \
  LLM_BASE_URL="$LLM_BASE_URL" \
  LLM_CONTEXT_WINDOW_TOKENS="$LLM_CONTEXT_WINDOW_TOKENS" \
  MODEL_EFFORT="$MODEL_EFFORT" \
  python3 - "$FLOW_DIR/models.json" <<'PY'
import json, os, sys

out_path = sys.argv[1]
proto = (os.environ.get("MODEL_PROTO_TYPE") or "openai-completions").strip()
model_id = (os.environ.get("LLM_MODEL_NAME") or "").strip()
base_url = (os.environ.get("LLM_BASE_URL") or "").strip().rstrip("/")
effort = (os.environ.get("MODEL_EFFORT") or "off").strip().lower()
try:
    ctx = int(os.environ.get("LLM_CONTEXT_WINDOW_TOKENS") or "128000")
except ValueError:
    ctx = 128000
if ctx < 1000 or ctx > 10_000_000:
    ctx = 128000

API_TYPE_MAP = {
    "openai": "openai-completions",
    "openai-completions": "openai-completions",
    "openai-responses": "openai-responses",
    "anthropic": "anthropic-messages",
    "anthropic-messages": "anthropic-messages",
}
api_type = API_TYPE_MAP.get(proto)
if not api_type:
    sys.stderr.write(
        f"[report] FATAL: unknown MODEL_PROTO_TYPE '{proto}'. "
        f"Valid: {', '.join(sorted(API_TYPE_MAP))}\n"
    )
    sys.exit(1)

PROVIDER = "platform"
API_KEY_ENV = "PLATFORM_API_KEY"

lo = f"{model_id} {base_url}".lower()
is_deepseek = "deepseek" in lo
is_zai = (not is_deepseek) and ("glm" in lo or "bigmodel" in lo or "zhipu" in lo or "z.ai" in lo)
THINKING_LEVELS = {"low", "medium", "high", "xhigh"}
is_thinking = effort in THINKING_LEVELS

model_entry = {
    "id": model_id,
    "input": ["text"],
    "contextWindow": ctx,
    "maxTokens": 16384,
}
if is_thinking or is_deepseek or is_zai:
    model_entry["reasoning"] = True
if is_deepseek:
    model_entry["compat"] = {"supportsDeveloperRole": False}

provider_cfg = {
    "api": api_type,
    "apiKey": f"${API_KEY_ENV}",
    "models": [model_entry],
}
if base_url:
    provider_cfg["baseUrl"] = base_url

models = {"providers": {PROVIDER: provider_cfg}}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(models, f, ensure_ascii=False, indent=2)
    f.write("\n")

model_string = f"{PROVIDER}/{model_id}"
if is_thinking:
    model_string += f":{effort}"
sys.stdout.write(model_string)
PY
)"

if [ -z "$V_DEFAULT_MODEL" ]; then
  echo "[report] FATAL: failed to generate models.json / resolve V_DEFAULT_MODEL" >&2
  exit 1
fi

cat > "$FLOW_DIR/.env" << ENVEOF
PLATFORM_API_KEY=${LLM_API_KEY}
V_DEFAULT_MODEL=${V_DEFAULT_MODEL}
YOUNGFLOW_IDLE_TIMEOUT=${YOUNGFLOW_IDLE_TIMEOUT:-3600}
YOUNGFLOW_ERROR_RETRIES=${YOUNGFLOW_ERROR_RETRIES:-5}
ENVEOF

echo "[report] Generated models.json + .env (model=$V_DEFAULT_MODEL, api=$MODEL_PROTO_TYPE, ctx=$LLM_CONTEXT_WINDOW_TOKENS)" >&2

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
