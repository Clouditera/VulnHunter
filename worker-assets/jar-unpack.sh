#!/bin/bash
# jar-unpack.sh (batch 3) — discover + classify + decompile jar/war/bare-class
# trees inside the audit work dir. Called by the onboard gate's step 2
# ("预处理"). Idempotent: an existing inventory.json with unchanged input
# fingerprints is a no-op (resume-safe).
#
# Classification rules (plan §5):
#   spring-boot fat jar → BOOT-INF/classes = business code (decompile);
#                          BOOT-INF/lib/*.jar = deps (GAV only)
#   tomcat shape        → WEB-INF/classes decompile; WEB-INF/lib GAV only
#   standalone jar      → META-INF/maven/**/pom.properties with a public
#                          groupId prefix → dependency (GAV only); else
#                          business code (decompile)
#   bare *.class dirs   → decompile queue directly
#
# Budget: 10min total decompile wall clock, 20000 classes total, 200MB per
# jar. Over-budget entries are recorded disposition=skipped-budget and
# prominently flagged in the summary (decide sees the flag as a lead signal).
#
# Output: $WORK_DIR/.vulnhunter-decompiled/<jar-stem>/**.java
#         $WORK_DIR/.vulnhunter-decompiled/inventory.json
set -u

WORK_DIR="${1:?usage: jar-unpack.sh <work_dir>}"
VF_JAR="${VINEFLOWER_JAR:-/opt/vulnhunter/bin/vineflower.jar}"
OUT_ROOT="$WORK_DIR/.vulnhunter-decompiled"
INVENTORY="$OUT_ROOT/inventory.json"
SUMMARY="$OUT_ROOT/summary.md"

BUDGET_SECONDS="${JAR_UNPACK_BUDGET_SECONDS:-600}"
BUDGET_CLASSES="${JAR_UNPACK_BUDGET_CLASSES:-20000}"
BUDGET_JAR_BYTES=$((200 * 1024 * 1024))

PUBLIC_GROUP_PREFIXES=(
  "org.apache." "org.springframework." "org.hibernate." "org.eclipse."
  "com.fasterxml." "com.google." "org.slf4j." "ch.qos." "io.netty."
  "org.junit." "org.mockito." "org.jetbrains." "org.projectlombok."
  "com.mysql." "org.postgresql." "redis.clients." "com.zaxxer."
  "org.mybatis." "com.alibaba." "cn.hutool." "javax." "jakarta."
  "org.glassfish." "org.jboss." "io.swagger." "com.squareup."
)

log() { echo "[jar-unpack] $*" >&2; }

command -v java >/dev/null 2>&1 || { log "java not found; nothing to do"; exit 0; }
[ -f "$VF_JAR" ] || { log "vineflower.jar missing at $VF_JAR; nothing to do"; exit 0; }
[ -d "$WORK_DIR" ] || { log "work dir not found: $WORK_DIR"; exit 1; }
mkdir -p "$OUT_ROOT"

# ── discovery ───────────────────────────────────────────────────────────
mapfile -t JARS < <(find "$WORK_DIR" -type f \( -name '*.jar' -o -name '*.war' \) \
  ! -path "$OUT_ROOT/*" ! -name 'vineflower.jar' 2>/dev/null | sort)
mapfile -t CLASS_DIRS < <(find "$WORK_DIR" -type f -name '*.class' ! -path "$OUT_ROOT/*" \
  -printf '%h\n' 2>/dev/null | sort -u)

if [ ${#JARS[@]} -eq 0 ] && [ ${#CLASS_DIRS[@]} -eq 0 ]; then
  log "no jar/war/class inputs; nothing to do"
  exit 0
fi

# ── idempotency fingerprint ─────────────────────────────────────────────
fingerprint() {
  {
    for j in "${JARS[@]:-}"; do [ -n "$j" ] && stat -c '%n %s %Y' "$j"; done
    find "$WORK_DIR" -type f -name '*.class' -printf '%p %s\n' 2>/dev/null | sort | head -5000
  } | sha256sum | awk '{print $1}'
}

FP="$(fingerprint)"
if [ -f "$INVENTORY" ]; then
  OLD_FP="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('fingerprint',''))" "$INVENTORY" 2>/dev/null || true)"
  if [ -n "$OLD_FP" ] && [ "$OLD_FP" = "$FP" ]; then
    log "inventory.json fingerprint unchanged; no-op (resume-safe)"
    exit 0
  fi
fi

START_TS=$(date +%s)
declare -a INVENTORY_ENTRIES=()
# Counters live in FILES, not variables: decompile_tree is invoked via command
# substitution (subshell), so any variable increments inside it are lost
# (architect rev2 — the 20000-class budget silently never decremented).
# Caller-side accumulators read/write these files only.
COUNTER_DIR="$(mktemp -d)"
COUNT_DECOMPILED="$COUNTER_DIR/decompiled"
COUNT_SKIPPED="$COUNTER_DIR/skipped"
echo 0 > "$COUNT_DECOMPILED"
echo 0 > "$COUNT_SKIPPED"

entry() { # path disposition gav size bytes_out
  INVENTORY_ENTRIES+=("$(python3 -c '
import json, sys
print(json.dumps({
  "path": sys.argv[1], "disposition": sys.argv[2],
  "gav": sys.argv[3] if sys.argv[3] != "" else None,
  "size_bytes": int(sys.argv[4]),
  "decompiled_files": int(sys.argv[5]),
}))
' "$1" "$2" "$3" "$4" "$5")")
}

budget_left() { echo $(( START_TS + BUDGET_SECONDS - $(date +%s) )); }
classes_left() { echo $(( BUDGET_CLASSES - $(cat "$COUNT_DECOMPILED") )); }
bump_decompiled() { echo $(( $(cat "$COUNT_DECOMPILED") + $1 )) > "$COUNT_DECOMPILED"; }
bump_skipped() { echo $(( $(cat "$COUNT_SKIPPED") + $1 )) > "$COUNT_SKIPPED"; }

# ── decompile helper ────────────────────────────────────────────────────
# Emits "<moved> <classes>" (two ints) on success, "-1 <classes>" when the
# class budget was exhausted, "-2 <classes>" on decompiler failure. Runs in a
# subshell via $(...) — MUST NOT touch counter variables; the caller bumps
# the counter files.
decompile_tree() { # src_root(classfile dir layout) dest_label
  local src_root="$1" label="$2" n
  local dest="$OUT_ROOT/$label"
  n=$(find "$src_root" -type f -name '*.class' 2>/dev/null | wc -l)
  [ "$n" -eq 0 ] && { echo "0 0"; return; }
  if [ "$(classes_left)" -lt "$n" ] || [ "$(budget_left)" -le 0 ]; then
    echo "-1 $n"
    return
  fi
  mkdir -p "$dest"
  local tmp; tmp="$(mktemp -d)"
  if timeout "$(budget_left)" java -jar "$VF_JAR" \
      --folder "$src_root" "$tmp" >/dev/null 2>&1; then
    # vineflower mirrors the class tree as .java under tmp
    local moved
    moved=$(find "$tmp" -type f -name '*.java' 2>/dev/null | wc -l)
    [ "$moved" -gt 0 ] && cp -r "$tmp"/. "$dest"/
    rm -rf "$tmp"
    echo "$moved $n"
  else
    rm -rf "$tmp" "$dest"
    echo "-2 $n"
  fi
}

# Caller-side wrapper: runs decompile_tree, parses the pair, bumps counters,
# and exports `last_moved`/`last_classes`/`last_status` for the inventory
# entry. last_status ∈ decompiled | skipped-budget | failed — the per-entry
# disposition MUST reflect reality (a tree never decompiled is never recorded
# as decompiled; architect rev3 audit-evidence integrity).
run_decompile() { # src_root label
  local out
  out="$(decompile_tree "$1" "$2")"
  last_moved="${out%% *}"
  last_classes="${out##* }"
  if [ "$last_moved" = "-1" ]; then
    bump_skipped 1
    last_status="skipped-budget"
    last_moved=0
  elif [ "$last_moved" = "-2" ]; then
    last_status="failed"
    last_moved=0
  else
    bump_decompiled "$last_classes"
    last_status="decompiled"
  fi
}

# ── GAV extraction from pom.properties ──────────────────────────────────
gav_of_pomprops() { # jarfile → "g:a:v" or ""
  local props="$1"
  python3 - "$props" <<'PY'
import sys
g=a=v=None
for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
    k, _, val = line.partition("=")
    k=k.strip(); val=val.strip()
    if k=="groupId": g=val
    elif k=="artifactId": a=val
    elif k=="version": v=val
if g and a and v: print(f"{g}:{a}:{v}")
PY
}

is_public_group() {
  local g="$1" p
  for p in "${PUBLIC_GROUP_PREFIXES[@]}"; do
    case "$g" in "$p"*) return 0 ;; esac
  done
  return 1
}

# ── per-jar processing ──────────────────────────────────────────────────
process_jar() { # jarfile
  local jar="$1" size stem staging
  size=$(stat -c '%s' "$jar")
  stem=$(basename "$jar" | sed 's/\.[jw]ar$//')
  staging="$(mktemp -d)"

  if [ "$size" -gt "$BUDGET_JAR_BYTES" ]; then
    entry "$jar" "skipped-budget" "" "$size" 0
    bump_skipped 1
    log "skip (size>200MB): $jar"
    rm -rf "$staging"; return
  fi

  unzip -q -o "$jar" -d "$staging" >/dev/null 2>&1 || { entry "$jar" "skipped-unreadable" "" "$size" 0; rm -rf "$staging"; return; }

  # spring-boot fat jar
  if [ -d "$staging/BOOT-INF/classes" ]; then
    run_decompile "$staging/BOOT-INF/classes" "$stem"
    entry "$jar" "$last_status" "" "$size" "$last_moved"
    for lib in "$staging"/BOOT-INF/lib/*.jar; do
      [ -f "$lib" ] || continue
      local gav=""
      local pp
      pp="$(unzip -Z1 "$lib" 2>/dev/null | grep -m1 'pom.properties$' || true)"
      if [ -n "$pp" ]; then
        unzip -q -p "$lib" "$pp" > "$staging/.pp" 2>/dev/null && gav="$(gav_of_pomprops "$staging/.pp")"
      fi
      entry "$lib" "dependency-only" "$gav" "$(stat -c '%s' "$lib")" 0
    done
    rm -rf "$staging"; return
  fi

  # tomcat war
  if [ -d "$staging/WEB-INF/classes" ]; then
    run_decompile "$staging/WEB-INF/classes" "$stem"
    entry "$jar" "$last_status" "" "$size" "$last_moved"
    for lib in "$staging"/WEB-INF/lib/*.jar; do
      [ -f "$lib" ] || continue
      local gav="" pp
      pp="$(unzip -Z1 "$lib" 2>/dev/null | grep -m1 'pom.properties$' || true)"
      if [ -n "$pp" ]; then
        unzip -q -p "$lib" "$pp" > "$staging/.pp" 2>/dev/null && gav="$(gav_of_pomprops "$staging/.pp")"
      fi
      entry "$lib" "dependency-only" "$gav" "$(stat -c '%s' "$lib")" 0
    done
    rm -rf "$staging"; return
  fi

  # standalone jar: public-group pom.properties → dependency; else business code
  local pp gav
  pp="$(unzip -Z1 "$jar" 2>/dev/null | grep -m1 'META-INF/maven/.*/pom.properties$' || true)"
  if [ -n "$pp" ]; then
    unzip -q -p "$jar" "$pp" > "$staging/.pp" 2>/dev/null
    gav="$(gav_of_pomprops "$staging/.pp")"
    if [ -n "$gav" ] && is_public_group "${gav%%:*}"; then
      entry "$jar" "dependency-only" "$gav" "$size" 0
      rm -rf "$staging"; return
    fi
  fi
  run_decompile "$staging" "$stem"
  entry "$jar" "$last_status" "" "$size" "$last_moved"
  rm -rf "$staging"
}

for j in "${JARS[@]:-}"; do
  [ -n "$j" ] || continue
  [ "$(budget_left)" -le 0 ] && { entry "$j" "skipped-budget" "" "$(stat -c '%s' "$j")" 0; bump_skipped 1; continue; }
  process_jar "$j"
done

# bare class dirs (deployment trees, unpacked wars, .class bundles)
for d in "${CLASS_DIRS[@]:-}"; do
  [ -n "$d" ] || continue
  case "$d" in "$OUT_ROOT"*) continue ;; esac
  local_label="bare-$(echo "$d" | sed 's#^'"$WORK_DIR"'/##; s#/#_#g' | head -c 60)"
  run_decompile "$d" "$local_label"
  entry "$d" "$last_status" "" "$(du -sb "$d" 2>/dev/null | cut -f1)" "$last_moved"
done

# ── inventory + summary ─────────────────────────────────────────────────
TMP_ENTRIES="$OUT_ROOT/.entries.jsonl"
: > "$TMP_ENTRIES"
for e in "${INVENTORY_ENTRIES[@]:-}"; do [ -n "$e" ] && printf '%s\n' "$e" >> "$TMP_ENTRIES"; done
python3 - "$TMP_ENTRIES" "$INVENTORY" "$SUMMARY" "$FP" "$COUNT_SKIPPED" <<'PY'
import json, sys, datetime
entries_path, inv_path, summary_path, fp, skipped_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
skipped = int(open(skipped_path).read().strip())
entries = [json.loads(l) for l in open(entries_path) if l.strip()]
json.dump({
  "fingerprint": fp,
  "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
  "budget": {"seconds": 600, "classes": 20000, "jar_bytes": 209715200},
  "entries": entries,
}, open(inv_path, "w"), indent=1, ensure_ascii=False)
dec = sum(1 for e in entries if e["disposition"] == "decompiled")
dep = sum(1 for e in entries if e["disposition"] == "dependency-only")
skipped_entry = sum(1 for e in entries if e["disposition"] in ("skipped-budget", "failed"))
skipped = max(skipped, skipped_entry)
lines = [
  "# jar-unpack 摘要", "",
  f"- 反编译目标: {dec}（业务码）",
  f"- 依赖（仅 GAV）: {dep}",
  f"- 预算截断跳过: {skipped}",
  "",
]
if skipped:
  lines += ["> ⚠️ 有输入因反编译预算（10min/20000 class/200MB per jar）被跳过"
            "（disposition=skipped-budget）。这些代码未进入审计面，"
            "可能隐藏漏洞——建议后续单独处理。", ""]
lines.append("明细见 inventory.json。")
open(summary_path, "w").write("\n".join(lines))
PY
rm -f "$TMP_ENTRIES"

log "done: entries=${#INVENTORY_ENTRIES[@]} decompiled_classes=$(cat "$COUNT_DECOMPILED") skipped_budget=$(cat "$COUNT_SKIPPED")"
rm -rf "$COUNTER_DIR"
exit 0
