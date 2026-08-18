#!/usr/bin/env bash
# Behavior tests for scripts/deploy/migrate.sh.
#
# Runs the real migrate script against a mocked stack: a PATH shim replaces
# docker, so the pull → compose run → wait → logs → cleanup state machine is
# exercised without a live app node or database. Exits non-zero on any
# assertion failure. Invoked by .github/workflows/ci.yml (deploy-script
# job) and usable locally via `bash scripts/deploy/test-migrate.sh`.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MIGRATE="$HERE/migrate.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

mkdir -p "$WORK/bin" "$WORK/app"

cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
# docker shim for migrate.sh tests:
#   - pull: no-op
#   - compose run -d: prints a fake container id, records the invocation
#   - wait: hangs when MIGRATE_HANG_FILE exists, else exits with the
#     scripted exit code from MIGRATE_RC_FILE
#   - inspect: prints the scripted exit code
#   - logs: prints the captured migration log
#   - kill/rm: no-op
set -uo pipefail

if [ "${1:-}" = "pull" ]; then
  exit 0
fi

if [ "${1:-}" = "compose" ] && [ "${2:-}" = "run" ]; then
  printf 'DOMINUS_IMAGE_TAG=%s args=%s\n' "${DOMINUS_IMAGE_TAG:-unset}" "$*" \
    >> "${MIGRATE_CALL_LOG:-/dev/null}"
  printf '%s\n' "${MIGRATE_CID:-migrate-test-cid}"
  exit 0
fi

if [ "${1:-}" = "wait" ]; then
  if [ -f "${MIGRATE_HANG_FILE:-/nonexistent}" ]; then
    while :; do sleep 1; done
  fi
  # Real `docker wait` prints the container's exit code and exits with it.
  rc="$(cat "${MIGRATE_RC_FILE:-/dev/null}" 2>/dev/null || echo 0)"
  printf '%s\n' "$rc"
  exit "$rc"
fi

if [ "${1:-}" = "inspect" ]; then
  cat "${MIGRATE_RC_FILE:-/dev/null}" 2>/dev/null || echo 0
  exit 0
fi

if [ "${1:-}" = "logs" ]; then
  cat "${MIGRATE_LOG_FILE:-/dev/null}" 2>/dev/null || true
  exit 0
fi

if [ "${1:-}" = "kill" ]; then
  # Simulate the container actually dying: the hang is lifted so the
  # subsequent `docker wait` in the timeout path returns.
  rm -f "${MIGRATE_HANG_FILE:-/nonexistent}"
  exit 0
fi

if [ "${1:-}" = "rm" ]; then
  exit 0
fi

exit 0
EOF

chmod +x "$WORK/bin/docker"

run_migrate() {
  local tag="$1"
  shift
  local out
  set +e
  out="$(
    PATH="$WORK/bin:$PATH" \
    COMPOSE_DIR="$WORK/app" \
    DOMINUS_TAG="$tag" \
    MIGRATE_TIMEOUT_SECONDS="${MIGRATE_TIMEOUT_SECONDS:-600}" \
    MIGRATE_CID="migrate-test-cid" \
    MIGRATE_CALL_LOG="$WORK/call-log" \
    MIGRATE_RC_FILE="$WORK/migrate-rc" \
    MIGRATE_HANG_FILE="$WORK/hang" \
    MIGRATE_LOG_FILE="$WORK/migrate-log" \
    bash "$MIGRATE" 2>&1
  )"
  local rc=$?
  set -e
  MIGRATE_OUT="$out"
  return $rc
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

# ── Case 1: happy path — migrations applied, container cleaned up ─────────
rm -f "$WORK/hang" "$WORK/migrate-rc" "$WORK/call-log"
printf '0\n' > "$WORK/migrate-rc"
printf 'migrations applied: 3 (54 → 57)\n' > "$WORK/migrate-log"
rc=0
run_migrate v1.1.0 || rc=$?
assert_eq "case1 exit code" 0 "$rc"
assert_contains "case1 up-to-date message" "schema is up to date for v1.1.0" "$MIGRATE_OUT"
assert_contains "case1 target image pulled" "pulling ghcr.io/alessiobrillo/dominus:v1.1.0" "$MIGRATE_OUT"
assert_contains "case1 migrate CLI invoked" "dist/db/migrate-cli.js" "$(cat "$WORK/call-log")"
assert_contains "case1 target tag forced via shell env" "DOMINUS_IMAGE_TAG=v1.1.0" "$(cat "$WORK/call-log")"

# ── Case 2: migration fails — no images rolled, loud failure ─────────────
rm -f "$WORK/hang"
printf '1\n' > "$WORK/migrate-rc"
printf 'migration failed: constraint violation\n' > "$WORK/migrate-log"
rc=0
run_migrate v1.1.0 || rc=$?
assert_eq "case2 exit code" 1 "$rc"
assert_contains "case2 failure message" "migrations failed (exit 1)" "$MIGRATE_OUT"
assert_contains "case2 no images rolled" "no images were rolled" "$MIGRATE_OUT"

# ── Case 3: timeout — container killed, PITR guidance, no roll ────────────
touch "$WORK/hang"
rm -f "$WORK/migrate-rc"
rc=0
MIGRATE_TIMEOUT_SECONDS=1 run_migrate v1.1.0 || rc=$?
rm -f "$WORK/hang"
assert_eq "case3 exit code" 1 "$rc"
assert_contains "case3 timeout message" "migrations timed out after 1s" "$MIGRATE_OUT"
assert_contains "case3 PITR guidance" "do NOT roll back blindly" "$MIGRATE_OUT"

# ── Case 4: missing DOMINUS_TAG — refuse to run ───────────────────────────
set +e
out="$(PATH="$WORK/bin:$PATH" COMPOSE_DIR="$WORK/app" bash "$MIGRATE" 2>&1)"
rc=$?
set -e
assert_eq "case4 exit code" 1 "$rc"
assert_contains "case4 refusal message" "DOMINUS_TAG is required" "$out"

printf '\nmigrate tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]