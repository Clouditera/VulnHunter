#!/bin/bash
# Onboard gate submit script (plan §4.3) — runs INSIDE the scan worker.
#
# The onboard stage's fixed five-step flow ends at a gate: this script POSTs
# the three-field result to the platform service (POST /internal/prepare-result,
# bearer = TASK_ID). Semantics:
#   - 200 {ok:true}            → gate passed; write the done marker and exit 0.
#   - 200 {ok:false,...}       → gate rejected (incomplete / no sandbox); the
#                                service already failed the task. Write the
#                                marker with the remediation, exit 42 — the
#                                worker entrypoint maps 42 to a clean gate
#                                exit (not a crash).
#   - 503 ERR_SANDBOX_ALLOC_RETRY → sandbox quota/capacity; retry with the
#                                stated backoff, max 6 attempts (~30min total
#                                budget; the platform watchdog caps at 30min
#                                anyway).
#   - other (401/409/4xx/5xx)  → hard failure: exit 43.
#
# Done marker: $OUTPUT_DIR/.vulnhunter-gate.json — resume/continue runs see it
# and skip the gate (idempotent), never re-submitting.
set -eu

SERVICE_URL="${SERVICE_URL:?SERVICE_URL is required}"
TASK_ID="${TASK_ID:?TASK_ID is required}"
# youngflow exports YOUNGFLOW_OUTPUT_DIR (workspace root) to every stage env.
OUTPUT_DIR="${OUTPUT_DIR:-${YOUNGFLOW_OUTPUT_DIR:-}}"
[ -n "$OUTPUT_DIR" ] || { echo "[gate] OUTPUT_DIR/YOUNGFLOW_OUTPUT_DIR unset" >&2; exit 43; }

GATE_MARKER="$OUTPUT_DIR/.vulnhunter-gate.json"
MAX_ATTEMPTS=6
BACKOFF_SECONDS=300
GATE_REJECT_EXIT=42
GATE_ERROR_EXIT=43

if [ -f "$GATE_MARKER" ]; then
  echo "[gate] done marker present; skipping gate submit" >&2
  exit 0
fi

payload="${1:?usage: submit-prepare-result.sh '<json>'}"

submit_once() {
  # SINGLE request: a second POST would hit taskBearerAuth 401 after the
  # first already transitioned the task out of `preparing` (architect rev1).
  # `-w '\n%{http_code}'` appends the status line after the body; split below.
  local raw
  raw=$(curl -sS --max-time 120 \
    -X POST "$SERVICE_URL/internal/prepare-result" \
    -H "Authorization: Bearer $TASK_ID" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    -w '\n%{http_code}' 2>&1) || return 75
  local status="${raw##*$'\n'}"
  local body="${raw%$'\n'*}"
  printf '%s %s' "$status" "$body"
}

attempt=1
while :; do
  response="$(submit_once)" || response="75 curl-error"
  status="${response%% *}"
  body="${response#* }"

  case "$status" in
    200)
      ok="$(printf '%s' "$body" | python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("ok")).lower())' 2>/dev/null || echo unknown)"
      if [ "$ok" = "true" ]; then
        printf '%s\n' "{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"ok\":true}" > "$GATE_MARKER"
        echo "[gate] passed" >&2
        exit 0
      fi
      remediation="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("remediation",""))' 2>/dev/null || true)"
      printf '%s\n' "{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"ok\":false,\"remediation\":\"$remediation\"}" > "$GATE_MARKER"
      echo "[gate] rejected: $remediation" >&2
      exit "$GATE_REJECT_EXIT"
      ;;
    503)
      if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
        echo "[gate] sandbox allocation retries exhausted ($MAX_ATTEMPTS)" >&2
        exit "$GATE_ERROR_EXIT"
      fi
      echo "[gate] sandbox allocation blocked (503); retry $attempt/$MAX_ATTEMPTS in ${BACKOFF_SECONDS}s" >&2
      attempt=$((attempt + 1))
      sleep "$BACKOFF_SECONDS"
      ;;
    *)
      echo "[gate] submit failed (HTTP $status): $body" >&2
      exit "$GATE_ERROR_EXIT"
      ;;
  esac
done
