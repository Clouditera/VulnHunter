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
  # fish 2026-08-09: output language (BCP-47). Empty → engine default zh-CN.
  if [ -n "${VULNFORGE_OUTPUT_LANGUAGE:-}" ]; then
    YOUNGFLOW_ARGS+=(--output-language "$VULNFORGE_OUTPUT_LANGUAGE")
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
    echo "[scan] VulnForge inputs: dynamic=true enable_poc=${VULNFORGE_ENABLE_POC:-false} enable_exp=${VULNFORGE_ENABLE_EXP:-false} enable_chain=${VULNFORGE_ENABLE_CHAIN:-false} sandbox_cfg_present=$([ -n "${VULNFORGE_SANDBOX_CFG:-}" ] && echo true || echo false) audit_scope_chars=${#VULNFORGE_AUDIT_SCOPE} vuln_focus_chars=${#VULNFORGE_VULN_FOCUS} user_instr_chars=${#VULNFORGE_USER_INSTR} output_language=${VULNFORGE_OUTPUT_LANGUAGE:-}" >&2
  else
    local effective_sched_instr="${EFFECTIVE_SCHED_INSTR:-${VULNFORGE_SCHED_INSTR:-$STATIC_ONLY_SCHED_INSTR}}"
    echo "[scan] VulnForge inputs: audit_scope_present=$([ -n "${VULNFORGE_AUDIT_SCOPE:-}" ] && echo true || echo false) audit_scope_chars=${#VULNFORGE_AUDIT_SCOPE} vuln_focus_present=$([ -n "${VULNFORGE_VULN_FOCUS:-}" ] && echo true || echo false) vuln_focus_chars=${#VULNFORGE_VULN_FOCUS} user_instr_present=$([ -n "${VULNFORGE_USER_INSTR:-}" ] && echo true || echo false) user_instr_chars=${#VULNFORGE_USER_INSTR} sched_instr_present=true sched_instr_chars=${#effective_sched_instr} enable_poc=false enable_exp=false sandbox_cfg_present=false output_language=${VULNFORGE_OUTPUT_LANGUAGE:-}" >&2
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
  # Platform-owned timeout marker (fish 2026-08-09): scheduler reads this
  # file — NOT engine completion.yaml — to set completion_reason=timeout.
  mkdir -p /workspace/out
  printf '%s\n' "{\"reason\":\"scan_timeout\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    > /workspace/out/.vulnhunter-timeout
  chmod 644 /workspace/out/.vulnhunter-timeout 2>/dev/null || true
  echo "[scan] Wrote platform timeout marker /workspace/out/.vulnhunter-timeout" >&2
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
  echo "[scan] FATAL: python3 not found — required for worker runtime" >&2
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
# Model config: consume pre-generated models.json from the unified module.
#
# Batch 2 (fish 2026-08-08): the service pre-generates models.json via
# buildModelsJson (credential-models.ts) and writes it to
# /workspace/.pi-agent/models.json + model-env.json before the worker starts.
# This script copies them into the flow directory.
#
# The old python3 heredoc generator is retired — a single source of truth
# (credential-models.ts) now feeds scan/report/chat/prepare/diagnostics.
# ---------------------------------------------------------------------------
PI_AGENT_SRC="/workspace/.pi-agent"

if [ ! -f "$PI_AGENT_SRC/models.json" ]; then
  echo "[scan] FATAL: pre-generated models.json not found at $PI_AGENT_SRC/models.json. The service must generate it before starting the worker." >&2
  exit 1
fi
if [ ! -f "$PI_AGENT_SRC/model-env.json" ]; then
  echo "[scan] FATAL: pre-generated model-env.json not found at $PI_AGENT_SRC/model-env.json." >&2
  exit 1
fi

# Copy models.json into the flow directory (youngflow reads it from here)
cp "$PI_AGENT_SRC/models.json" "$FLOW_DIR/models.json"

# Extract V_DEFAULT_MODEL from model-env.json (written by service)
V_DEFAULT_MODEL="$(python3 -c "import json; print(json.load(open('$PI_AGENT_SRC/model-env.json'))['vDefaultModel'])" 2>/dev/null || echo '')"
if [ -z "$V_DEFAULT_MODEL" ]; then
  echo "[scan] FATAL: failed to read vDefaultModel from model-env.json" >&2
  exit 1
fi

# Write .env for youngflow: model selection + engine tuning. API key lives in
# the container env (VULNHUNTER_LLM_API_KEY), expanded by pi via the
# $VULNHUNTER_LLM_API_KEY template in models.json.
cat > "$FLOW_DIR/.env" << EOF
V_DEFAULT_MODEL=${V_DEFAULT_MODEL}
V_STRONG_MODEL=${V_DEFAULT_MODEL}
YOUNGFLOW_IDLE_TIMEOUT=${YOUNGFLOW_IDLE_TIMEOUT:-3600}
YOUNGFLOW_ERROR_RETRIES=${YOUNGFLOW_ERROR_RETRIES:-5}
EOF

echo "[scan] Copied pre-generated models.json + wrote .env (model=$V_DEFAULT_MODEL)" >&2
# pi-web-access (research/hunt stages) reads PI_CODING_AGENT_DIR/web-search.json.
# youngflow sets PI_CODING_AGENT_DIR=<flowDir>/.pi-agent and copies models.json
# into it (dist/model-config.js createAgentDir); it does NOT copy other files.
# Pre-create the dir + file here: youngflow's recursive mkdir is non-destructive
# and only overwrites auth.json/settings.json/models.json, so web-search.json
# survives. workflow=none skips the interactive curator — unattended workers
# have no one to click it (fish/architect 2026-08-06).
mkdir -p "$FLOW_DIR/.pi-agent"
printf '%s\n' '{"workflow":"none"}' > "$FLOW_DIR/.pi-agent/web-search.json"

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

# Onboard gate exit codes (submit-prepare-result.sh): 42 = gate rejected
# (task already failed by the platform), 43 = gate submit hard error. NOTE:
# a stage-internal bash exit does NOT become the youngflow process exit code
# in general — this branch only catches the case where youngflow itself
# propagates the gate script's code. The authoritative collection for gate
# failure is the platform stopping the container (SIGTERM→143) after the
# callback failed the claim; this passthrough is belt-and-braces.
if [ "$EXIT" -eq 42 ] || [ "$EXIT" -eq 43 ]; then
  echo "[scan] Onboard gate ended the run (exit=$EXIT)" >&2
  finish_log
  trap - EXIT TERM INT HUP
  cleanup_finalize_control 2>/dev/null || true
  return "$EXIT"
fi

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
