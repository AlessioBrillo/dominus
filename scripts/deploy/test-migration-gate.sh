#!/usr/bin/env bash
# Behavior tests for scripts/deploy/migration-gate.sh.
#
# Runs the real migration_gate() function (and the standalone entry point)
# against PATH-shimmed docker: `run --entrypoint node ... --list` serves
# per-tag image manifests, `compose exec postgres psql` serves the applied
# set from APPLIED_FILE (or models a fresh/missing table, or a database
# outage via DB_DOWN_FLAG). Exits non-zero on any assertion failure.
# Invoked by .github/workflows/ci.yml (release-gate job) and usable locally
# via `bash scripts/deploy/test-migration-gate.sh`.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/migration-gate.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

mkdir -p "$WORK/bin" "$WORK/app"

# â”€â”€ PATH shims â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
# docker shim for gate tests: image manifests per tag, psql applied set
# from APPLIED_FILE, DB_DOWN_FLAG models an unreachable database.
set -uo pipefail

manifest_for() {
  local tag="$1"
  [ "$tag" = "legacy" ] && return 1
  local list
  list="$(find "$MANIFEST_DIR" -maxdepth 1 -name '????_*.ts' -printf '%f\n' | sort)"
  [ "$tag" = "v1.1.0" ] && list="$list"$'\n'"0054_gate_demo"
  printf '%s\n' "$list" | sed 's/\.ts$//'
  return 0
}

if [ "${1:-}" = "run" ]; then
  # run --rm --entrypoint node IMAGE dist/db/migration-manifest-cli.js --list
  manifest_for "${5##*:}"
  exit $?
fi

if [ "${1:-}" = "compose" ] && [ "${2:-}" = "exec" ]; then
  if [ -f "${DB_DOWN_FLAG:-}" ]; then
    echo "psql: could not connect to server" >&2
    exit 1
  fi
  if [ -n "${APPLIED_FILE:-}" ] && [ -f "$APPLIED_FILE" ]; then
    cat "$APPLIED_FILE"
    exit 0
  fi
  echo 'psql: relation "schema_migrations" does not exist' >&2
  exit 1
fi

exit 0
EOF
chmod +x "$WORK/bin/docker"

# â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
REPO_MANIFEST="$(
  find "$HERE/../../src/db/migrations" -maxdepth 1 -name '????_*.ts' \
    -printf '%f\n' | sort | sed 's/\.ts$//'
)"
V110_MANIFEST="$REPO_MANIFEST"$'\n'"0054_gate_demo"

write_applied() { printf '%s\n' "$@" > "$WORK/applied"; }

run_gate() {
  local image="$1" out rc=0
  # `|| rc=$?` keeps this safe under set -e: a refused gate must not kill
  # the harness; the exit code is captured into GATE_RC.
  out="$(
    PATH="$WORK/bin:$PATH" \
    MANIFEST_DIR="$HERE/../../src/db/migrations" \
    DB_DOWN_FLAG="$WORK/db-down-flag" \
    APPLIED_FILE="${APPLIED_FILE:-}" \
    SKIP_MIGRATION_GATE="${SKIP_MIGRATION_GATE:-}" \
    bash -c 'source "$1"; migration_gate "$2" "$3"' _ "$GATE" "$image" "$WORK/app" 2>&1
  )" || rc=$?
  GATE_OUT="$out"
  GATE_RC=$rc
  return 0
}

run_gate_standalone() {
  local out rc=0
  out="$(
    PATH="$WORK/bin:$PATH" \
    MANIFEST_DIR="$HERE/../../src/db/migrations" \
    DB_DOWN_FLAG="$WORK/db-down-flag" \
    APPLIED_FILE="${APPLIED_FILE:-}" \
    bash "$GATE" --image "$1" --compose-dir "$WORK/app" 2>&1
  )" || rc=$?
  GATE_OUT="$out"
  GATE_RC=$rc
  return 0
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$label" "$expected" "$actual"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  missing: %s\n  output:  %s\n' "$label" "$needle" "$haystack"
  fi
}

rm -f "$WORK/app/.schema-state"

# â”€â”€ Case A: fresh database (no schema_migrations) — allowed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
unset APPLIED_FILE SKIP_MIGRATION_GATE
run_gate "ghcr.io/alessiobrillo/dominus:v1.1.0"
assert_eq "A exit code" 0 "$GATE_RC"
assert_contains "A fresh state accepted" "no applied migrations — fresh state, OK" "$GATE_OUT"

# â”€â”€ Case B: applied set is a prefix — allowed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
APPLIED_FILE="$WORK/applied"
write_applied $REPO_MANIFEST
run_gate "ghcr.io/alessiobrillo/dominus:v1.1.0"
assert_eq "B exit code" 0 "$GATE_RC"
assert_contains "B prefix verified" "schema compatible (54 applied" "$GATE_OUT"

# â”€â”€ Case C: applied set equals the target manifest — allowed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
write_applied $V110_MANIFEST
run_gate "ghcr.io/alessiobrillo/dominus:v1.1.0"
assert_eq "C exit code" 0 "$GATE_RC"
assert_contains "C equal manifest accepted" "schema compatible (55 applied" "$GATE_OUT"

# â”€â”€ Case D: downgrade — database ahead of the image — refused â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
write_applied $V110_MANIFEST
run_gate "ghcr.io/alessiobrillo/dominus:v1.0.0"
assert_eq "D exit code" 1 "$GATE_RC"
assert_contains "D ahead refused" "database schema is ahead of this image" "$GATE_OUT"

# â”€â”€ Case E: applied set diverges from the manifest — refused â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
write_applied "0001_foreign_demo" $REPO_MANIFEST
run_gate "ghcr.io/alessiobrillo/dominus:v1.1.0"
assert_eq "E exit code" 1 "$GATE_RC"
assert_contains "E prefix mismatch refused" "is not a prefix" "$GATE_OUT"

# â”€â”€ Case F: out-of-order applied set — refused â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
write_applied "0002_create_scoring_runs" "0001_create_candidates" "0003_create_portfolio"
run_gate "ghcr.io/alessiobrillo/dominus:v1.1.0"
assert_eq "F exit code" 1 "$GATE_RC"
assert_contains "F out-of-order refused" "is not a prefix" "$GATE_OUT"

# â”€â”€ Case G: legacy image (no CLI), state matches — allowed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
printf 'SCHEMA_APPLIED_COUNT=55\n' > "$WORK/app/.schema-state"
write_applied $V110_MANIFEST
run_gate "ghcr.io/alessiobrillo/dominus:legacy"
assert_eq "G exit code" 0 "$GATE_RC"
assert_contains "G legacy state match allowed" "unchanged since last green" "$GATE_OUT"

# â”€â”€ Case H: legacy image, state mismatch — refused â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
printf 'SCHEMA_APPLIED_COUNT=54\n' > "$WORK/app/.schema-state"
write_applied $V110_MANIFEST
run_gate "ghcr.io/alessiobrillo/dominus:legacy"
assert_eq "H exit code" 1 "$GATE_RC"
assert_contains "H legacy state mismatch refused" "last green deploy recorded 54" "$GATE_OUT"

# â”€â”€ Case I: legacy image, no state file — refused â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
rm -f "$WORK/app/.schema-state"
write_applied $V110_MANIFEST
run_gate "ghcr.io/alessiobrillo/dominus:legacy"
assert_eq "I exit code" 1 "$GATE_RC"
assert_contains "I legacy no state refused" "no manifest CLI and no .schema-state" "$GATE_OUT"

# â”€â”€ Case J: database unreachable — refused â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
rm -f "$WORK/app/.schema-state"
touch "$WORK/db-down-flag"
write_applied $REPO_MANIFEST
run_gate "ghcr.io/alessiobrillo/dominus:v1.1.0"
assert_eq "J exit code" 1 "$GATE_RC"
assert_contains "J db unreachable refused" "database unreachable" "$GATE_OUT"
rm -f "$WORK/db-down-flag"

# â”€â”€ Case K: SKIP_MIGRATION_GATE=1 — allowed without verification â”€â”€â”€â”€â”€â”€â”€â”€
SKIP_MIGRATION_GATE=1
run_gate "ghcr.io/alessiobrillo/dominus:v1.0.0"
assert_eq "K exit code" 0 "$GATE_RC"
assert_contains "K escape hatch logged" "SKIP_MIGRATION_GATE=1" "$GATE_OUT"
unset SKIP_MIGRATION_GATE

# â”€â”€ Case L: standalone entry point — fresh database allowed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
unset APPLIED_FILE
rm -f "$WORK/app/.schema-state"
run_gate_standalone "ghcr.io/alessiobrillo/dominus:v1.1.0"
assert_eq "L exit code" 0 "$GATE_RC"
assert_contains "L standalone fresh accepted" "no applied migrations — fresh state, OK" "$GATE_OUT"

# â”€â”€ Case M: standalone entry point, missing --image — usage error â”€â”€â”€â”€â”€â”€â”€
set +e
STANDALONE_USAGE="$(
  PATH="$WORK/bin:$PATH" bash "$GATE" --compose-dir "$WORK/app" 2>&1
)"
STANDALONE_RC=$?
set -e
assert_eq "M exit code" 2 "$STANDALONE_RC"
assert_contains "M usage message" "usage: migration-gate.sh" "$STANDALONE_USAGE"

printf '\nmigration-gate tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
