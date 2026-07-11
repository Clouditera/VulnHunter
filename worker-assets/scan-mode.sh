#!/bin/bash
set -e

FLOW_DIR="/opt/vulnagent/flows/vulnforge"
FLOW_FILE="$FLOW_DIR/flow.audit.yaml"
STATIC_ONLY_SCHED_INSTR="平台策略：本次仅执行静态审计；不得选择 poc-verify 或 exp-build；完成静态审计后进入报告阶段。"

build_youngflow_args() {
  YOUNGFLOW_ARGS=(
    "$FLOW_FILE"
    --work-dir /workspace/src
    --output-dir /workspace/out
    --json-log
    --max-parallel "${YOUNGFLOW_MAX_PARALLEL:-3}"
  )
  if [ -n "${VULNFORGE_AUDIT_SCOPE:-}" ]; then
    YOUNGFLOW_ARGS+=(--audit-scope "$VULNFORGE_AUDIT_SCOPE")
  fi
  if [ -n "${VULNFORGE_VULN_FOCUS:-}" ]; then
    YOUNGFLOW_ARGS+=(--vuln-focus "$VULNFORGE_VULN_FOCUS")
  fi
  EFFECTIVE_SCHED_INSTR="${VULNFORGE_SCHED_INSTR:-$STATIC_ONLY_SCHED_INSTR}"
  YOUNGFLOW_ARGS+=(--sched-instr "$EFFECTIVE_SCHED_INSTR")
  if [ -n "${VULNFORGE_USER_INSTR:-}" ]; then
    YOUNGFLOW_ARGS+=(--user-instr "$VULNFORGE_USER_INSTR")
  fi

  # M1-02 hard gate: task metadata/env cannot enable dynamic execution and no
  # sandbox_cfg is accepted until a validated Prepare allocation exists.
  YOUNGFLOW_ARGS+=(--enable-poc false --enable-exp false)

  if [ -n "${UNTIL:-}" ]; then
    YOUNGFLOW_ARGS+=(--until "$UNTIL")
  fi
  if [ -n "${RECURSION_LIMIT:-}" ]; then
    YOUNGFLOW_ARGS+=(--recursion-limit "$RECURSION_LIMIT")
  fi
  if [ "${RESUME:-0}" = "1" ]; then
    YOUNGFLOW_ARGS+=(--resume)
  fi
  if [ "${CONTINUE:-0}" = "1" ]; then
    YOUNGFLOW_ARGS+=(--continue)
  fi
}

log_input_summary() {
  local effective_sched_instr="${EFFECTIVE_SCHED_INSTR:-${VULNFORGE_SCHED_INSTR:-$STATIC_ONLY_SCHED_INSTR}}"
  echo "[scan] VulnForge inputs: audit_scope_present=$([ -n "${VULNFORGE_AUDIT_SCOPE:-}" ] && echo true || echo false) audit_scope_chars=${#VULNFORGE_AUDIT_SCOPE} vuln_focus_present=$([ -n "${VULNFORGE_VULN_FOCUS:-}" ] && echo true || echo false) vuln_focus_chars=${#VULNFORGE_VULN_FOCUS} user_instr_present=$([ -n "${VULNFORGE_USER_INSTR:-}" ] && echo true || echo false) user_instr_chars=${#VULNFORGE_USER_INSTR} sched_instr_present=true sched_instr_chars=${#effective_sched_instr} enable_poc=false enable_exp=false sandbox_cfg_present=false" >&2
}

main() {
TASK_ID="${TASK_ID:?TASK_ID is required}"
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
  echo "[scan] FATAL: python3 not found — required for models.json generation" >&2
  exit 1
fi
if [ ! -f "$FLOW_FILE" ]; then
  echo "[scan] FATAL: VulnForge audit flow not found: $FLOW_FILE" >&2
  exit 1
fi
echo "[scan] Preflight OK: python3 + VulnForge audit flow available" >&2

# Code already extracted to /workspace/src/ by service (bind mount)

# ---------------------------------------------------------------------------
# Model config for the new VulnForge audit flow.
#
# YoungFlow 0.3.x no longer translates LLM_* env vars into pi config; the flow
# declares `artifacts.models_json: models.json` and resolves its model via
# `${env.V_DEFAULT_MODEL}` / `${env.V_STRONG_MODEL}` (flow model env
# interpolation, v0.3.7). So we generate, at scan start, from the platform
# credential env:
#   - $FLOW_DIR/models.json : pi-native provider/API details
#   - $FLOW_DIR/.env        : V_DEFAULT_MODEL / V_STRONG_MODEL + API key env
#
# Current worker pi is @earendil-works/pi-coding-agent; its config resolver
# supports $ENV / ${ENV} templates in models.json. Keep VulnForge's natural
# three-layer shape: models.json points at an API-key env var, .env carries the
# secret, and flow.yaml selects model names via ${env.*}.
# ---------------------------------------------------------------------------
MODEL_PROTO_TYPE="${MODEL_PROTO_TYPE:-openai-completions}"
LLM_MODEL_NAME="${LLM_MODEL_NAME:-}"
LLM_BASE_URL="${LLM_BASE_URL:-}"
LLM_API_KEY="${LLM_API_KEY:-}"
MODEL_EFFORT="${MODEL_EFFORT:-off}"
LLM_CONTEXT_WINDOW_TOKENS="${LLM_CONTEXT_WINDOW_TOKENS:-128000}"

if [ -z "$LLM_MODEL_NAME" ] || [ -z "$LLM_API_KEY" ]; then
  echo "[scan] FATAL: model credential not configured (LLM_MODEL_NAME / LLM_API_KEY missing). Configure a model in Settings before scanning." >&2
  exit 1
fi

# Generate models.json from the platform credential. Emits the resolved
# V_DEFAULT_MODEL string (provider/model[:effort]) on stdout for the .env.
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

# Platform proto_type -> pi api type.
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
        f"[scan] FATAL: unknown MODEL_PROTO_TYPE '{proto}'. "
        f"Valid: {', '.join(sorted(API_TYPE_MAP))}\n"
    )
    sys.exit(1)

PROVIDER = "platform"
API_KEY_ENV = "PLATFORM_API_KEY"

lo = f"{model_id} {base_url}".lower()
is_deepseek = "deepseek" in lo
is_zai = (not is_deepseek) and ("glm" in lo or "bigmodel" in lo or "zhipu" in lo or "z.ai" in lo)

# Reasoning effort: only known thinking levels become a model suffix.
THINKING_LEVELS = {"low", "medium", "high", "xhigh"}
is_thinking = effort in THINKING_LEVELS

# DeepSeek custom endpoints need explicit compat (developer role unsupported);
# zai/glm reasoning models also flag reasoning.
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
  echo "[scan] FATAL: failed to generate models.json / resolve V_DEFAULT_MODEL" >&2
  exit 1
fi

# Write .env for youngflow: model selection + API key + engine tuning.
# enable_poc is intentionally NOT set (dynamic reproduction is out of scope).
# The secret stays in .env; models.json contains only the env-var name.
cat > "$FLOW_DIR/.env" << EOF
PLATFORM_API_KEY=${LLM_API_KEY}
V_DEFAULT_MODEL=${V_DEFAULT_MODEL}
V_STRONG_MODEL=${V_DEFAULT_MODEL}
YOUNGFLOW_IDLE_TIMEOUT=${YOUNGFLOW_IDLE_TIMEOUT:-3600}
YOUNGFLOW_ERROR_RETRIES=${YOUNGFLOW_ERROR_RETRIES:-5}
EOF

echo "[scan] Generated models.json + .env (model=$V_DEFAULT_MODEL, api=$MODEL_PROTO_TYPE, ctx=$LLM_CONTEXT_WINDOW_TOKENS)" >&2

if [ "${RESUME:-0}" != "1" ] && [ "${CONTINUE:-0}" != "1" ]; then
  rm -rf /workspace/out
fi
mkdir -p /workspace/.service-logs
rm -f "$SERVICE_LOG"

YOUNGFLOW_MAX_PARALLEL=${YOUNGFLOW_MAX_PARALLEL:-3}
build_youngflow_args
log_input_summary

# Scan-duration termination: wrap youngflow in coreutils `timeout`.
EFFECTIVE_TIMEOUT="${SCAN_TIMEOUT:-216000}"

echo "[scan] Running youngflow (version=$(youngflow --version), model=$V_DEFAULT_MODEL, max_parallel=$YOUNGFLOW_MAX_PARALLEL, timeout=${EFFECTIVE_TIMEOUT}s, flow=$FLOW_FILE)..." >&2
set +e
timeout --signal=TERM --kill-after=30 "${EFFECTIVE_TIMEOUT}s" \
  youngflow "${YOUNGFLOW_ARGS[@]}" 2>"$SERVICE_LOG"
EXIT=$?
set -e

# timeout returns 124 (TERM) or 137 (KILL after --kill-after) when the scan
# duration cap is hit. That is an expected, successful termination: normalize
# to 0 so the scheduler runs sync + index on the produced findings.
if [ "$EXIT" = "124" ] || [ "$EXIT" = "137" ]; then
  echo "[scan] Scan stopped after ${EFFECTIVE_TIMEOUT}s scan-duration cap (normal termination)" >&2
  EXIT=0
fi

finish_log
trap - EXIT

echo "[scan] Done (exit=$EXIT)" >&2
return "$EXIT"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
