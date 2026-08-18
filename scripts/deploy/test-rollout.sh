#!/usr/bin/env bash
# Behavior tests for scripts/deploy/rollout.sh.
#
# Runs the real rollout script against a mocked stack: PATH shims replace
# docker and curl, so the full deploy → verify → health → rollback state
# machine is exercised without a live app node. Exits non-zero on any
# assertion failure. Invoked by .github/workflows/ci.yml (deploy-script
# job) and usable locally via `bash scripts/deploy/test-rollout.sh`.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROLLOUT="$HERE/rollout.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0

# ── PATH shims ──────────────────────────────────────────────────────────
mkdir -p "$WORK/bin" "$WORK/app"

cat > "$WORK/bin/docker" <<'EOF'
#!/usr/bin/env bash
# docker shim: pull/up are no-ops; inspect reports the tag from .env,
# unless the mismatch flag is set (models a stale image being rolled).
# `run --entrypoint node IMAGE ... --list` prints the image's migration
# manifest; `compose exec postgres psql` reports the applied set from the
# "database" (captured once from the .env tag, or read from APPLIED_FILE).
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
  if [ -n "${APPLIED_FILE:-}" ]; then
    cat "$APPLIED_FILE"
    exit 0
  fi
  if [ ! -f "$CAPTURED_FILE" ]; then
    tag="$(sed -n 's/^DOMINUS_IMAGE_TAG=//p' "$APP_DIR/.env" 2>/dev/null || true)"
    if ! manifest_for "$tag" > "$CAPTURED_FILE" 2>/dev/null; then
      rm -f "$CAPTURED_FILE"
    fi
  fi
  if [ -f "$CAPTURED_FILE" ]; then
    cat "$CAPTURED_FILE"
    exit 0
  fi
  echo 'psql: relation "schema_migrations" does not exist' >&2
  exit 1
fi

if [ "${1:-}" = "inspect" ]; then
  svc="$(basename "${@: -1}")"        # dominus-api-1 / dominus-worker-1
  svc="${svc#dominus-}"; svc="${svc%-1}"
  if [ -f "$MISMATCH_FLAG" ] && [ "$svc" = "api" ]; then
    echo "ghcr.io/alessiobrillo/dominus:stale-image"
    exit 0
  fi
  tag="$(sed -n 's/^DOMINUS_IMAGE_TAG=//p' "$APP_DIR/.env")"
  img="ghcr.io/alessiobrillo/dominus:${tag}"
  [ "$svc" != "api" ] && img="${img}-${svc}"
  echo "$img"
  exit 0
fi
exit 0
EOF

cat > "$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
# curl shim: exit 0 only when the healthy flag is set.
set -uo pipefail
[ -f "$HEALTHY_FLAG" ] && exit 0
exit 22
EOF

chmod +x "$WORK/bin/docker" "$WORK/bin/curl"

run_rollout() {
  local tag="$1"
  local dir="$2"
  local out
  # Each invocation is a fresh scenario: drop the shim's captured applied
  # set and the migration-gate state from previous runs.
  rm -f "$dir/.applied-captured" "$dir/.schema-state"
  set +e
  out="$(
    PATH="$WORK/bin:$PATH" \
    COMPOSE_DIR="$dir" \
    APP_DIR="$dir" \
    HEALTHY_FLAG="$WORK/healthy" \
    MISMATCH_FLAG="$WORK/mismatch" \
    MANIFEST_DIR="$HERE/../../src/db/migrations" \
    CAPTURED_FILE="$dir/.applied-captured" \
    DB_DOWN_FLAG="$WORK/db-down-flag" \
    DOMINUS_TAG="$tag" \
    HEALTH_ATTEMPTS=2 \
    HEALTH_POLL_SECONDS=0 \
    bash "$ROLLOUT" 2>&1
  )"
  local rc=$?
  set -e
  ROLLOUT_OUT="$out"
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

current_tag() { sed -n 's/^DOMINUS_IMAGE_TAG=//p' "$1/.env"; }

# ── Case 1: happy path — new tag deployed, api healthy ──────────────────
cat > "$WORK/app/.env" <<'EOF'
DOMINUS_IMAGE_TAG=v1.0.0
EOF
rm -f "$WORK/healthy" "$WORK/mismatch"
touch "$WORK/healthy"
rc=0
run_rollout v1.1.0 "$WORK/app" || rc=$?
assert_eq "case1 exit code" 0 "$rc"
assert_eq "case1 .env updated" "v1.1.0" "$(current_tag "$WORK/app")"
assert_contains "case1 success message" "api healthy on v1.1.0 after roll" "$ROLLOUT_OUT"

# ── Case 2: health never green — automatic rollback to previous tag ─────
cat > "$WORK/app/.env" <<'EOF'
DOMINUS_IMAGE_TAG=v1.0.0
EOF
rm -f "$WORK/healthy" "$WORK/mismatch"
rc=0
run_rollout v1.1.0 "$WORK/app" || rc=$?
assert_eq "case2 exit code (failed release)" 1 "$rc"
assert_eq "case2 .env restored" "v1.0.0" "$(current_tag "$WORK/app")"
assert_contains "case2 rollback message" "rolling back to v1.0.0" "$ROLLOUT_OUT"
assert_contains "case2 rollback completed, health still broken" "rolled back to v1.0.0 but api is still unhealthy" "$ROLLOUT_OUT"

# ── Case 3: image mismatch on roll — rollback restores a healthy stack ──
cat > "$WORK/app/.env" <<'EOF'
DOMINUS_IMAGE_TAG=v1.0.0
EOF
rm -f "$WORK/mismatch"
touch "$WORK/healthy" "$WORK/mismatch"
rc=0
run_rollout v1.1.0 "$WORK/app" || rc=$?
assert_eq "case3 exit code (failed release)" 1 "$rc"
assert_eq "case3 .env restored" "v1.0.0" "$(current_tag "$WORK/app")"
assert_contains "case3 mismatch detected" "expected api to run ghcr.io/alessiobrillo/dominus:v1.1.0, running ghcr.io/alessiobrillo/dominus:stale-image" "$ROLLOUT_OUT"

# ── Case 4: rollback itself fails — loud failure, no silent success ─────
cat > "$WORK/app/.env" <<'EOF'
DOMINUS_IMAGE_TAG=v1.0.0
EOF
rm -f "$WORK/healthy"
touch "$WORK/mismatch"
rc=0
run_rollout v1.1.0 "$WORK/app" || rc=$?
assert_eq "case4 exit code" 1 "$rc"
assert_contains "case4 manual intervention flagged" "ROLLBACK FAILED" "$ROLLOUT_OUT"

# ── Case 5: missing previous tag — refuse to deploy ─────────────────────
printf 'FOO=bar\n' > "$WORK/app/.env"
rm -f "$WORK/healthy" "$WORK/mismatch"
touch "$WORK/healthy"
rc=0
run_rollout v1.1.0 "$WORK/app" || rc=$?
assert_eq "case5 exit code" 1 "$rc"
assert_contains "case5 refusal message" "refusing to deploy" "$ROLLOUT_OUT"
assert_eq "case5 .env untouched" "" "$(current_tag "$WORK/app")"

# ── Case 6: same-tag redeploy with broken health — no useless rollback ──
cat > "$WORK/app/.env" <<'EOF'
DOMINUS_IMAGE_TAG=v1.1.0
EOF
rm -f "$WORK/healthy" "$WORK/mismatch"
rc=0
run_rollout v1.1.0 "$WORK/app" || rc=$?
assert_eq "case6 exit code" 1 "$rc"
assert_contains "case6 no rollback message" "there is no previous tag to restore" "$ROLLOUT_OUT"

printf '\nrollout tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
