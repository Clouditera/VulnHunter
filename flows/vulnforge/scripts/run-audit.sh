#!/bin/bash
set -euo pipefail

# HALL-35: local/direct-run entry for the VulnForge audit flow.
#
# `--enable-poc` / `--enable-exp` stay the public input contract; this wrapper
# derives the engine gate config (dynamic.yaml) from them before handing off
# to youngflow, so there is exactly ONE source of truth. Platform runs
# (worker image) do the same inside scan-mode.sh from trusted env — this
# script is the equivalent for local invocations.
#
# Usage: scripts/run-audit.sh <flow.yaml> [youngflow flags...]
#   --work-dir / --output-dir   as in youngflow (output dir defaults to work dir)
#   --enable-poc / --enable-exp  "true"/"false"/"1"/"0" (default false, fail-closed)

ENABLE_POC_RAW="false"
ENABLE_EXP_RAW="false"
OUT_DIR=""

# Observe the public flags without rewriting anything — every argument is
# passed through to youngflow untouched.
dynamic_flags_from_args() {
  local args=("$@")
  local i=0
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      --enable-poc)
        ENABLE_POC_RAW="${args[$((i + 1))]:-false}"; i=$((i + 2));;
      --enable-poc=*)
        ENABLE_POC_RAW="${args[$i]#*=}"; i=$((i + 1));;
      --enable-exp)
        ENABLE_EXP_RAW="${args[$((i + 1))]:-false}"; i=$((i + 2));;
      --enable-exp=*)
        ENABLE_EXP_RAW="${args[$i]#*=}"; i=$((i + 1));;
      --output-dir)
        OUT_DIR="${args[$((i + 1))]:-}"; i=$((i + 2));;
      --output-dir=*)
        OUT_DIR="${args[$i]#*=}"; i=$((i + 1));;
      --work-dir)
        # youngflow defaults output_dir to work_dir — mirror it as fallback.
        if [ -z "$OUT_DIR" ]; then OUT_DIR="${args[$((i + 1))]:-}"; fi; i=$((i + 2));;
      --work-dir=*)
        if [ -z "$OUT_DIR" ]; then OUT_DIR="${args[$i]#*=}"; fi; i=$((i + 1));;
      *)
        i=$((i + 1));;
    esac
  done
  # Fail-closed defaults (also youngflow's own semantics when absent).
  if [ -z "$OUT_DIR" ]; then OUT_DIR="."; fi
}

# Fail-closed truthiness: only well-known spellings enable; anything else
# (garbage, empty, typo) keeps the gate closed.
dynamic_true() {
  case "${1:-}" in
    1|t|T|true|TRUE|True|yes|on) return 0;;
    *) return 1;;
  esac
}

# Write the engine gate config the poc_gate / exp_gate joins route on.
write_gate_config() {
  local out_dir="$1"
  local poc_raw="$2"
  local exp_raw="$3"
  local poc_yaml="false" exp_yaml="false"
  if dynamic_true "$poc_raw"; then poc_yaml="true"; fi
  if dynamic_true "$exp_raw"; then exp_yaml="true"; fi
  mkdir -p "$out_dir"
  cat > "$out_dir/dynamic.yaml" <<EOF
version: 1
dynamic:
  poc_enabled: ${poc_yaml}
  exp_enabled: ${exp_yaml}
EOF
  echo "[run-audit] dynamic gate config → ${out_dir}/dynamic.yaml (poc=${poc_yaml} exp=${exp_yaml})" >&2
}

main() {
  dynamic_flags_from_args "$@"
  write_gate_config "$OUT_DIR" "$ENABLE_POC_RAW" "$ENABLE_EXP_RAW"
  exec youngflow "$@"
}

# Only run as script; tests source the functions instead.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
