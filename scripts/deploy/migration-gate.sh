#!/usr/bin/env bash
# Schema migration gate for DOMINUS Cloud rollouts.
#
# Loaded by rollout.sh (source "$(dirname "$0")/migration-gate.sh") and
# usable standalone:
#   bash migration-gate.sh --image ghcr.io/alessiobrillo/dominus:v1.1.0 \
#     --compose-dir /opt/dominus
#
# Purpose: an image may only boot against a database whose applied
# migration set is a strict prefix of the image's own manifest. This
# prevents two failure modes:
#   1. Downgrade deploy — an old image rolled onto a migrated schema.
#   2. Auto-rollback onto a migrated schema — the new release booted,
#      applied migrations, then failed health; rolling back boots the
#      previous image against the new schema.
# Both fail closed: refuse, log loudly, and restore from a PITR backup
# (see docs/releases/migration-policy.md).
#
# Images that predate the manifest CLI cannot be verified from the image
# itself. They are checked against .schema-state, the applied-migration
# count recorded at the last green deploy: if the database has not moved
# since, the rollback is safe.
#
# Escape hatch (use with intent): SKIP_MIGRATION_GATE=1 skips the check.

set -uo pipefail

# --- helpers -------------------------------------------------------------

gate_log() { printf 'MIGRATION GATE: %s\n' "$*" >&2; }

gate_image_ref() {
  local tag="$1"
  printf 'ghcr.io/alessiobrillo/dominus:%s' "$tag"
}

# Extract the applied migration names from the database, one per line.
# The schema_migrations table may not exist yet (fresh database) — that is
# the compatible empty state. Any other psql failure is a database
# reachability problem and is reported as such.
gate_db_applied() {
  local dir="$1" user db out rc
  user="$(sed -n 's/^POSTGRES_USER=//p' "$dir/.env" 2>/dev/null | tail -n 1 || true)"
  user="${user:-dominus}"
  db="$(sed -n 's/^POSTGRES_DB=//p' "$dir/.env" 2>/dev/null | tail -n 1 || true)"
  db="${db:-dominus}"

  # The if-guard keeps this safe under the caller's `set -e` (rollout.sh):
  # a failing psql must be captured, not abort the script.
  if ! out="$(
    cd "$dir" && docker compose exec -T postgres \
      psql -U "$user" -d "$db" -tAc \
      'SELECT migration_name FROM schema_migrations ORDER BY id' 2>&1
  )"; then
    rc=$?
    if printf '%s' "$out" | grep -q "does not exist"; then
      return 0 # schema_migrations missing = never migrated
    fi
    gate_log "database unreachable (psql rc=$rc): ${out}"
    return 1
  fi
  # `|| true` keeps the caller's `set -e` alive when psql returned no rows
  # (empty applied set is a valid state).
  printf '%s\n' "$out" | grep -v '^[[:space:]]*$' || true
  return 0
}

gate_db_applied_count() {
  local dir="$1"
  gate_db_applied "$dir" | wc -l
}

# Record the applied count after a green deploy, so legacy images (without
# the manifest CLI) can later be verified against the last-known-good state.
gate_write_state() {
  local dir="$1" count
  if count="$(gate_db_applied_count "$dir")"; then
    printf 'SCHEMA_APPLIED_COUNT=%s\n' "$count" > "$dir/.schema-state"
  fi
}

# --- gate core -----------------------------------------------------------

# Verify that image is allowed to boot against the database in dir.
# Returns 0 (allowed) or 1 (refused); refusal reasons are printed.
# The decision is persisted in GATE_DECISION for tests/audit.
migration_gate() {
  local image="$1" dir="${2:-${COMPOSE_DIR:-$(pwd)}}"
  local work manifest_file applied_file manifest applied rc
  GATE_DECISION=""

  if [ "${SKIP_MIGRATION_GATE:-}" = "1" ]; then
    gate_log "SKIP_MIGRATION_GATE=1 — schema compatibility NOT verified for ${image}"
    GATE_DECISION="skipped"
    return 0
  fi

  work="$(mktemp -d)"
  trap 'rm -rf "$work"' RETURN

  if ! manifest="$(docker run --rm --entrypoint node "$image" \
      dist/db/migration-manifest-cli.js --list 2>/dev/null)"; then
    gate_log "${image} does not ship the migration manifest CLI (pre-gate image)"
    migration_gate_legacy "$image" "$dir"
    return $?
  fi

  if ! applied="$(gate_db_applied "$dir")"; then
    gate_log "refusing to deploy ${image} — database state is unknown"
    GATE_DECISION="refused-db-unreachable"
    return 1
  fi

  manifest_file="$work/manifest"
  applied_file="$work/applied"
  printf '%s\n' "$manifest" | grep -v '^[[:space:]]*$' > "$manifest_file" || true
  printf '%s\n' "$applied" | grep -v '^[[:space:]]*$' > "$applied_file" || true

  rc=0
  if [ ! -s "$applied_file" ]; then
    gate_log "${image}: database has no applied migrations — fresh state, OK"
  elif [ "$(wc -l < "$applied_file")" -gt "$(wc -l < "$manifest_file")" ]; then
    gate_log "${image} refused: database schema is ahead of this image " \
      "($(wc -l < "$applied_file") applied vs $(wc -l < "$manifest_file") known). " \
      "Downgrade or rollback onto a migrated schema — restore from a PITR backup."
    rc=1
  elif ! head -n "$(wc -l < "$applied_file")" "$manifest_file" | cmp -s - "$applied_file"; then
    gate_log "${image} refused: applied migration set is not a prefix of this " \
      "image's manifest (unknown migrations or out-of-order state)."
    rc=1
  else
    gate_log "${image}: schema compatible ($(wc -l < "$applied_file") applied, prefix verified)"
  fi

  if [ "$rc" -eq 0 ]; then
    GATE_DECISION="allowed"
  else
    GATE_DECISION="refused"
  fi
  return "$rc"
}

# Legacy image without the manifest CLI: verify against .schema-state, the
# applied count recorded at the last green deploy.
migration_gate_legacy() {
  local image="$1" dir="$2"
  local state_file="$dir/.schema-state" state_count db_count

  if [ ! -f "$state_file" ]; then
    gate_log "${image} refused: no manifest CLI and no .schema-state — cannot " \
      "verify schema. Re-deploy a gated image or restore from a PITR backup."
    GATE_DECISION="refused-legacy-no-state"
    return 1
  fi
  state_count="$(sed -n 's/^SCHEMA_APPLIED_COUNT=//p' "$state_file" | tail -n 1)"
  if ! db_count="$(gate_db_applied_count "$dir")"; then
    gate_log "${image} refused — database state is unknown"
    GATE_DECISION="refused-db-unreachable"
    return 1
  fi
  if [ "${db_count}" = "${state_count}" ]; then
    gate_log "${image} (legacy, no CLI): database unchanged since last green " \
      "deploy (${db_count} applied) — allowed"
    GATE_DECISION="allowed-legacy-state"
    return 0
  fi
  gate_log "${image} (legacy, no CLI) refused: database has ${db_count} " \
    "applied migrations but the last green deploy recorded ${state_count}. " \
    "The schema has moved — do NOT boot this image; restore from a PITR backup."
  GATE_DECISION="refused-legacy-state"
  return 1
}

# --- standalone entry point ----------------------------------------------

if [ "$(basename "$0")" = "migration-gate.sh" ]; then
  IMAGE=""
  COMPOSE_DIR_VAL=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --image) IMAGE="$2"; shift 2 ;;
      --compose-dir) COMPOSE_DIR_VAL="$2"; shift 2 ;;
      *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
  done
  if [ -z "$IMAGE" ]; then
    echo "usage: migration-gate.sh --image <image-ref> [--compose-dir <dir>]" >&2
    exit 2
  fi
  migration_gate "$IMAGE" "${COMPOSE_DIR_VAL:-$(pwd)}"
  exit $?
fi
