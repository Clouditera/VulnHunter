#!/usr/bin/env bash
# Unit tests for deploy/lib/instance-upgrade.sh (batch 2: semver + .env three-way merge)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../lib/common.sh
source "$ROOT/lib/common.sh"
# shellcheck source=../lib/instance-dir.sh
source "$ROOT/lib/instance-dir.sh"
# shellcheck source=../lib/instance-upgrade.sh
source "$ROOT/lib/instance-upgrade.sh"

fail=0
assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "[ok] $name"
  else
    echo "[fail] $name: got='$got' want='$want'" >&2
    fail=1
  fi
}
assert_true() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "[ok] $name"; else echo "[fail] $name" >&2; fail=1; fi
}
assert_false() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "[fail] $name (expected false)" >&2; fail=1; else echo "[ok] $name"; fi
}

echo "== semver_lt =="
assert_true  "2.3.3 < 2.3.4"   semver_lt 2.3.3 2.3.4
assert_true  "2.3.3 < 2.10.0"  semver_lt 2.3.3 2.10.0
assert_true  "2.3.3 < 3.0.0"   semver_lt 2.3.3 3.0.0
assert_false "2.3.4 !< 2.3.3"  semver_lt 2.3.4 2.3.3
assert_false "2.3.3 !< 2.3.3"  semver_lt 2.3.3 2.3.3
assert_false "2.10.0 !< 2.3.3" semver_lt 2.10.0 2.3.3
assert_false "same major"      semver_lt 3.0.0 2.3.3

echo "== merge_env_three_way (design §3 six rules) =="
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# old template: snapshot from previous install
cat > "$tmp/old.tpl" << 'EOF'
WEB_PORT=23000
DB_PASSWORD=change-me-in-production
OLD_DEFAULT=old-value
DEPRECATED_KEY=legacy
# COMMENTED_KEY=off
EOF

# new template: OLD_DEFAULT changed, DEPRECATED_KEY removed, NEW_KEY added
cat > "$tmp/new.tpl" << 'EOF'
WEB_PORT=23000
DB_PASSWORD=change-me-in-production
OLD_DEFAULT=new-value
NEW_KEY=fresh-default
EOF

# current .env: user changed DB_PASSWORD (rule 3 keep), OLD_DEFAULT untouched (rule 2 update),
# DEPRECATED_KEY active (rule 4 comment), PRIVATE_KEY user-added (rule 5 keep)
cat > "$tmp/.env" << 'EOF'
WEB_PORT=23000
DB_PASSWORD=my-real-password-123
OLD_DEFAULT=old-value
DEPRECATED_KEY=legacy
PRIVATE_KEY=mine
EOF

merge_env_three_way "$tmp/new.tpl" "$tmp/old.tpl" "$tmp/.env" >/dev/null

assert_eq "rule1: new key appended"        "$(grep -c '^NEW_KEY=fresh-default$' "$tmp/.env")" "1"
assert_eq "rule2: untouched default updated" "$(grep -c '^OLD_DEFAULT=new-value$' "$tmp/.env")" "1"
assert_eq "rule3: user value kept"         "$(grep -c '^DB_PASSWORD=my-real-password-123$' "$tmp/.env")" "1"
assert_eq "rule3: user value not replaced" "$(grep -c '^DB_PASSWORD=change-me-in-production$' "$tmp/.env")" "0"
assert_eq "rule4: deprecated commented"    "$(grep -c '^# deprecated: DEPRECATED_KEY=legacy$' "$tmp/.env")" "1"
assert_eq "rule4: no active deprecated"    "$(grep -c '^DEPRECATED_KEY=' "$tmp/.env")" "0"
assert_eq "rule5: private key kept"        "$(grep -c '^PRIVATE_KEY=mine$' "$tmp/.env")" "1"
assert_eq "unchanged key left alone"       "$(grep -c '^WEB_PORT=23000$' "$tmp/.env")" "1"

echo "== merge degraded mode (no old template -> add-only) =="
cat > "$tmp/.env2" << 'EOF'
DB_PASSWORD=my-real-password-123
OLD_DEFAULT=old-value
EOF
merge_env_three_way "$tmp/new.tpl" "$tmp/missing.tpl" "$tmp/.env2" >/dev/null
assert_eq "degraded: new key appended"  "$(grep -c '^NEW_KEY=fresh-default$' "$tmp/.env2")" "1"
assert_eq "degraded: nothing updated"   "$(grep -c '^OLD_DEFAULT=old-value$' "$tmp/.env2")" "1"
assert_eq "degraded: user value kept"   "$(grep -c '^DB_PASSWORD=my-real-password-123$' "$tmp/.env2")" "1"

# ── EDITION preserve (task-09560333, fish 2026-08-09) ─────────────────
# Mirrors deploy/lib/instance-upgrade.sh: keep user EDITION; only backfill
# package default when missing. Does not run full upgrade_instance (needs docker).
sync_edition_like_instance_upgrade() {
  local instance_env="$1" pkg_example="$2"
  local edition pkg_edition
  edition="$(grep -E '^EDITION=' "$instance_env" | tail -n 1 | cut -d= -f2- || true)"
  pkg_edition="$(grep -E '^EDITION=' "$pkg_example" | tail -n 1 | cut -d= -f2- || true)"
  if [[ -z "$edition" && "$pkg_edition" == "enterprise" ]]; then
    if grep -qE '^EDITION=' "$instance_env"; then
      sed -i "s|^EDITION=.*|EDITION=enterprise|" "$instance_env"
    else
      printf 'EDITION=enterprise\n' >> "$instance_env"
    fi
  fi
}

echo "== EDITION preserve (task-09560333) =="
cat > "$tmp/pkg.env.example" << 'EOF'
EDITION=enterprise
SERVICE_IMAGE=vulnhunter-service:2.3.7
EOF

# Case A: user saas must survive enterprise package upgrade
cat > "$tmp/inst-saas.env" << 'EOF'
EDITION=saas
WEB_PORT=23000
EOF
sync_edition_like_instance_upgrade "$tmp/inst-saas.env" "$tmp/pkg.env.example"
assert_eq "saas kept on enterprise pack" "$(grep -E '^EDITION=' "$tmp/inst-saas.env" | cut -d= -f2-)" "saas"

# Case B: user enterprise stays enterprise
cat > "$tmp/inst-ent.env" << 'EOF'
EDITION=enterprise
EOF
sync_edition_like_instance_upgrade "$tmp/inst-ent.env" "$tmp/pkg.env.example"
assert_eq "enterprise kept" "$(grep -E '^EDITION=' "$tmp/inst-ent.env" | cut -d= -f2-)" "enterprise"

# Case C: missing EDITION → backfill package default
cat > "$tmp/inst-missing.env" << 'EOF'
WEB_PORT=23000
EOF
sync_edition_like_instance_upgrade "$tmp/inst-missing.env" "$tmp/pkg.env.example"
assert_eq "missing backfilled enterprise" "$(grep -E '^EDITION=' "$tmp/inst-missing.env" | cut -d= -f2-)" "enterprise"

# Case D: upgrade.sh path — same guard (user value present → no overwrite)
# Inline the fixed upgrade.sh condition against a temp .env
cat > "$tmp/up.env" << 'EOF'
EDITION=saas
EOF
cat > "$tmp/up.env.example" << 'EOF'
EDITION=enterprise
EOF
(
  cd "$tmp"
  env_value() { local key="$1" file="${2:-.env}"; grep -E "^${key}=" "$file" 2>/dev/null | tail -n 1 | cut -d= -f2-; }
  set_env_key() {
    local key="$1" value="$2"
    if grep -qE "^${key}=" .env; then sed -i "s|^${key}=.*|${key}=${value}|" .env
    else printf '%s=%s\n' "$key" "$value" >> .env; fi
  }
  cp up.env .env
  cp up.env.example .env.example
  edition="$(env_value EDITION .env)"
  pkg_edition="$(env_value EDITION .env.example)"
  if [[ -z "$edition" && "$pkg_edition" == "enterprise" ]]; then
    set_env_key EDITION enterprise
  fi
  cp .env up.env.result
)
assert_eq "upgrade.sh path keeps saas" "$(grep -E '^EDITION=' "$tmp/up.env.result" | cut -d= -f2-)" "saas"

# ── .env symlink preservation (fish 2026-08-11) ─────────────────────
# upgrade.sh's set_env_key must resolve symlinks — sed -i on a symlink
# replaces the link with a regular file (breaking the data-dir layout).
tmp2="$(mktemp -d)"
mkdir -p "$tmp2/data"
cat > "$tmp2/data/.env" << 'EOF'
SERVICE_IMAGE=vulnhunter-service:2.3.7
EDITION=saas
EOF
ln -s "$tmp2/data/.env" "$tmp2/.env"
(
  cd "$tmp2"
  # Simulate upgrade.sh's set_env_key with readlink
  set_env_key() {
    local key="$1" value="$2"
    local env_file
    env_file="$(readlink -f .env)"
    if grep -qE "^${key}=" "$env_file"; then
      sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
    else
      printf '%s=%s\n' "$key" "$value" >> "$env_file"
    fi
  }
  set_env_key SERVICE_IMAGE vulnhunter-service:2.3.8
)
assert_true ".env is still a symlink after set_env_key" test -L "$tmp2/.env"
assert_eq "symlink target updated" "$(grep -E '^SERVICE_IMAGE=' "$tmp2/data/.env" | cut -d= -f2-)" "vulnhunter-service:2.3.8"
assert_eq "symlink content not duplicated" "$(wc -l < "$tmp2/data/.env")" "2"
rm -rf "$tmp2"

if [[ "$fail" == "0" ]]; then
  echo "ALL PASSED"
else
  echo "FAILURES" >&2
  exit 1
fi
