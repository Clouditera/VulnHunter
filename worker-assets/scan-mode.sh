#!/bin/bash
set -e

FLOW_DIR="/opt/vulnhunter/flows/vulnforge"
FLOW_FILE="$FLOW_DIR/flow.audit.yaml"
TIMEOUT_FLOW_FILE="/opt/vulnhunter/flows/vulnforge-timeout/flow.timeout-finalize.yaml"
DEADLINE_RUNNER="/opt/run-with-deadline.py"
FINALIZE_ARTIFACTS="/opt/timeout-finalize-artifacts.py"
FINALIZE_CONTROL="/workspace/.timeout-finalize"
SUPERVISOR_PID=""
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
  if [ "${VULNFORGE_DYNAMIC_ENABLED:-false}" = "true" ]; then
    # H1/H5 §5: dynamic run — no static-only restriction; the task's own
    # sched_instr (if any) passes through, otherwise the flow default applies.
    if [ -n "${VULNFORGE_SCHED_INSTR:-}" ]; then
      YOUNGFLOW_ARGS+=(--sched-instr "$VULNFORGE_SCHED_INSTR")
    fi
  else
    EFFECTIVE_SCHED_INSTR="${VULNFORGE_SCHED_INSTR:-$STATIC_ONLY_SCHED_INSTR}"
    YOUNGFLOW_ARGS+=(--sched-instr "$EFFECTIVE_SCHED_INSTR")
  fi
  if [ -n "${VULNFORGE_USER_INSTR:-}" ]; then
    YOUNGFLOW_ARGS+=(--user-instr "$VULNFORGE_USER_INSTR")
  fi

  if [ "${VULNFORGE_DYNAMIC_ENABLED:-false}" = "true" ]; then
    # H1: dynamic inputs consumed from the platform env (sandbox_cfg always
    # present on this path — spawn fails loud otherwise).
    YOUNGFLOW_ARGS+=(--enable-poc "${VULNFORGE_ENABLE_POC:-false}" --enable-exp "${VULNFORGE_ENABLE_EXP:-false}" --enable-chain "${VULNFORGE_ENABLE_CHAIN:-false}")
    if [ -n "${VULNFORGE_SANDBOX_CFG:-}" ]; then
      YOUNGFLOW_ARGS+=(--sandbox-cfg "$VULNFORGE_SANDBOX_CFG")
    fi
  else
    # M1-02 hard gate: static tasks never execute dynamic stages.
    YOUNGFLOW_ARGS+=(--enable-poc false --enable-exp false)
  fi

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
  if [ "${VULNFORGE_DYNAMIC_ENABLED:-false}" = "true" ]; then
    echo "[scan] VulnForge inputs: dynamic=true enable_poc=${VULNFORGE_ENABLE_POC:-false} enable_exp=${VULNFORGE_ENABLE_EXP:-false} enable_chain=${VULNFORGE_ENABLE_CHAIN:-false} sandbox_cfg_present=$([ -n "${VULNFORGE_SANDBOX_CFG:-}" ] && echo true || echo false) audit_scope_chars=${#VULNFORGE_AUDIT_SCOPE} vuln_focus_chars=${#VULNFORGE_VULN_FOCUS} user_instr_chars=${#VULNFORGE_USER_INSTR}" >&2
  else
    local effective_sched_instr="${EFFECTIVE_SCHED_INSTR:-${VULNFORGE_SCHED_INSTR:-$STATIC_ONLY_SCHED_INSTR}}"
    echo "[scan] VulnForge inputs: audit_scope_present=$([ -n "${VULNFORGE_AUDIT_SCOPE:-}" ] && echo true || echo false) audit_scope_chars=${#VULNFORGE_AUDIT_SCOPE} vuln_focus_present=$([ -n "${VULNFORGE_VULN_FOCUS:-}" ] && echo true || echo false) vuln_focus_chars=${#VULNFORGE_VULN_FOCUS} user_instr_present=$([ -n "${VULNFORGE_USER_INSTR:-}" ] && echo true || echo false) user_instr_chars=${#VULNFORGE_USER_INSTR} sched_instr_present=true sched_instr_chars=${#effective_sched_instr} enable_poc=false enable_exp=false sandbox_cfg_present=false" >&2
  fi
}

calculate_finalize_budget() {
  local analysis="$1" budget
  case "$analysis" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$analysis" -gt 0 ] || return 1
  budget=$(( (analysis + 4) / 5 ))
  [ "$budget" -ge 120 ] || budget=120
  [ "$budget" -le 600 ] || budget=600
  printf '%s\n' "$budget"
}

run_supervised() {
  local timeout_seconds="$1" log_mode="$2"
  shift 2
  set +e
  if [ "$log_mode" = "append" ]; then
    python3 "$DEADLINE_RUNNER" --timeout "$timeout_seconds" --grace 30 -- "$@" 2>>"$SERVICE_LOG" &
  else
    python3 "$DEADLINE_RUNNER" --timeout "$timeout_seconds" --grace 30 -- "$@" 2>"$SERVICE_LOG" &
  fi
  SUPERVISOR_PID=$!
  wait "$SUPERVISOR_PID"
  local result=$?
  SUPERVISOR_PID=""
  set -e
  return "$result"
}

cleanup_finalize_control() {
  [ ! -e "$FINALIZE_CONTROL" ] || python3 "$FINALIZE_ARTIFACTS" cleanup --control-dir "$FINALIZE_CONTROL"
}

terminate_scan() {
  local signal_name="$1" exit_code="$2"
  trap - EXIT TERM INT HUP
  if [ -n "$SUPERVISOR_PID" ]; then
    kill -s "$signal_name" "$SUPERVISOR_PID" 2>/dev/null || true
    wait "$SUPERVISOR_PID" 2>/dev/null || true
    SUPERVISOR_PID=""
  fi
  cleanup_finalize_control 2>/dev/null || true
  finish_log 2>/dev/null || true
  exit "$exit_code"
}

handle_analysis_exit() {
  local analysis_exit="$1" analysis_seconds="$2"
  if [ "$analysis_exit" -eq 124 ]; then
    run_timeout_finalizer "$analysis_seconds"
    return $?
  fi
  return "$analysis_exit"
}

run_timeout_finalizer() {
  local analysis_seconds="$1" finalize_budget
  finalize_budget="$(calculate_finalize_budget "$analysis_seconds")" || return 2
  cleanup_finalize_control || return 3
  local prepare_result
  prepare_result="$(python3 "$FINALIZE_ARTIFACTS" prepare \
    --out-dir /workspace/out \
    --control-dir "$FINALIZE_CONTROL" \
    --analysis-limit-seconds "$analysis_seconds")" || return 3
  echo "[scan] Timeout artifact prepare: $prepare_result" >&2

  # Finalization is a single bounded attempt. The shared ephemeral env keeps
  # the selected provider but disables YoungFlow's outer stage retry loop.
  sed -i 's/^YOUNGFLOW_ERROR_RETRIES=.*/YOUNGFLOW_ERROR_RETRIES=0/' "$FLOW_DIR/.env"

  echo "[scan] Deadline reached; starting bounded report finalizer (budget=${finalize_budget}s)" >&2
  local final_exit=0
  run_supervised "$finalize_budget" append \
    youngflow "$TIMEOUT_FLOW_FILE" \
      --work-dir /workspace/src \
      --output-dir /workspace/out \
      --artifact-inventory "$FINALIZE_CONTROL/inventory.json" \
      --analysis-limit-seconds "$analysis_seconds" \
      --continue \
      --json-log \
      --max-parallel 1 || final_exit=$?
  echo "[scan] Finalize phase exit=$final_exit" >&2
  [ "$final_exit" -eq 0 ] || return "$final_exit"
  local verify_result
  verify_result="$(python3 "$FINALIZE_ARTIFACTS" verify \
    --out-dir /workspace/out \
    --control-dir "$FINALIZE_CONTROL")" || return 3
  echo "[scan] Timeout artifact verify: $verify_result" >&2
  cleanup_finalize_control || return 3
  return 0
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

trap 'terminate_scan TERM 143' TERM HUP
trap 'terminate_scan INT 130' INT
trap 'cleanup_finalize_control 2>/dev/null || true; finish_log' EXIT

echo "[scan] Starting scan for task: $TASK_ID" >&2

# Preflight: verify critical dependencies
if ! command -v python3 &>/dev/null; then
  echo "[scan] FATAL: python3 not found — required for models.json generation" >&2
  exit 1
fi
for required in "$FLOW_FILE" "$TIMEOUT_FLOW_FILE" "$DEADLINE_RUNNER" "$FINALIZE_ARTIFACTS"; do
  if [ ! -f "$required" ]; then
    echo "[scan] FATAL: required scan asset not found: $required" >&2
    exit 1
  fi
done
echo "[scan] Preflight OK: python3 + main/finalizer flows + deadline gates available" >&2

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
MODEL_EFFORT="${MODEL_EFFORT:-off}"
LLM_CONTEXT_WINDOW_TOKENS="${LLM_CONTEXT_WINDOW_TOKENS:-128000}"

# Direct credential: the worker uses the real LLM credential (LLM_BASE_URL +
# LLM_API_KEY) injected by the service. Model-proxy removed (fish 2026-08-04).
LLM_DIRECT_BASE_URL="${LLM_BASE_URL:-}"

if [ -z "$LLM_MODEL_NAME" ] || [ -z "$LLM_API_KEY" ]; then
  echo "[scan] FATAL: model credential not configured (LLM_MODEL_NAME / LLM_API_KEY missing). Configure a model in Settings before scanning." >&2
  exit 1
fi

# Generate models.json from the platform credential. Emits the resolved
# V_DEFAULT_MODEL string (provider/model[:effort]) on stdout for the .env.
V_DEFAULT_MODEL="$(
  MODEL_PROTO_TYPE="$MODEL_PROTO_TYPE" \
  LLM_MODEL_NAME="$LLM_MODEL_NAME" \
  LLM_DIRECT_BASE_URL="$LLM_DIRECT_BASE_URL" \
  LLM_CONTEXT_WINDOW_TOKENS="$LLM_CONTEXT_WINDOW_TOKENS" \
  MODEL_EFFORT="$MODEL_EFFORT" \
  python3 - "$FLOW_DIR/models.json" <<'PY'
import json, os, sys

out_path = sys.argv[1]
proto = (os.environ.get("MODEL_PROTO_TYPE") or "openai-completions").strip()
model_id = (os.environ.get("LLM_MODEL_NAME") or "").strip()
direct_url = (os.environ.get("LLM_DIRECT_BASE_URL") or "").strip().rstrip("/")
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
API_KEY_ENV = "LLM_API_KEY"

lo = f"{model_id}".lower()
is_deepseek = "deepseek" in lo
is_zai = (not is_deepseek) and ("glm" in lo or "bigmodel" in lo or "zhipu" in lo or "z.ai" in lo)

# Reasoning effort: only known thinking levels become a model suffix.
THINKING_LEVELS = {"low", "medium", "high", "xhigh"}
is_thinking = effort in THINKING_LEVELS

# fish 2026-08-05: openai-completions endpoints get the conservative default
# `supportsDeveloperRole: False` — system is understood by every gateway,
# developer only matters on OpenAI o-series (which accept system too).
# responses protocol keeps developer (native there). zai/glm/deepseek are
# flagged reasoning for effort handling.
model_entry = {
    "id": model_id,
    "input": ["text"],
    "contextWindow": ctx,
    "maxTokens": 16384,
}
if is_thinking or is_deepseek or is_zai:
    model_entry["reasoning"] = True
if api_type == "openai-completions":
    model_entry["compat"] = {"supportsDeveloperRole": False}

provider_cfg = {
    "api": api_type,
    "apiKey": f"${API_KEY_ENV}",
    "models": [model_entry],
    # Direct credential: real base_url + real key (model-proxy removed).
    "baseUrl": direct_url,
}

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

# Write .env for youngflow: model selection + engine tuning. API key lives in
# the container env (LLM_API_KEY), expanded by youngflow via $LLM_API_KEY.
cat > "$FLOW_DIR/.env" << EOF
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

# The supervisor reserves 124 exclusively for its own deadline. Child 137/OOM,
# crash, provider failure, and external cancellation remain non-deadline exits.
EFFECTIVE_TIMEOUT="${SCAN_TIMEOUT:-216000}"
calculate_finalize_budget "$EFFECTIVE_TIMEOUT" >/dev/null || {
  echo "[scan] FATAL: SCAN_TIMEOUT must be a positive integer" >&2
  return 2
}

echo "[scan] Running youngflow (version=$(youngflow --version), model=$V_DEFAULT_MODEL, max_parallel=$YOUNGFLOW_MAX_PARALLEL, timeout=${EFFECTIVE_TIMEOUT}s, flow=$FLOW_FILE)..." >&2
EXIT=0
run_supervised "$EFFECTIVE_TIMEOUT" truncate youngflow "${YOUNGFLOW_ARGS[@]}" || EXIT=$?
if [ "$EXIT" -eq 124 ]; then FINALIZER_TRIGGERED=true; else FINALIZER_TRIGGERED=false; fi
echo "[scan] Analysis phase exit=$EXIT finalizer_triggered=$FINALIZER_TRIGGERED analysis_budget=${EFFECTIVE_TIMEOUT}s" >&2

PHASE_EXIT=0
handle_analysis_exit "$EXIT" "$EFFECTIVE_TIMEOUT" || PHASE_EXIT=$?
EXIT=$PHASE_EXIT

finish_log
trap - EXIT TERM INT HUP
cleanup_finalize_control 2>/dev/null || true

echo "[scan] Done (exit=$EXIT)" >&2
return "$EXIT"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
