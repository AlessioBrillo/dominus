#!/usr/bin/env bash
# DOMINUS Cloud — image rollout with automatic rollback.
#
# Uploaded to the app node and executed by .github/workflows/deploy.yml.
# Runs from /opt/dominus (the stack directory); the target tag arrives via
# the DOMINUS_TAG environment variable. On any failure — image tag
# mismatch after the roll, or the health poll never going green — the
# previous DOMINUS_IMAGE_TAG from .env is restored, the stack is re-pulled
# and re-rolled, and the health poll runs again. The workflow exits 1 even
# when the rollback succeeds so the failed release stays visible, while the
# service is left healthy.
#
# Schema migration gate (see docs/releases/migration-policy.md): before any
# roll, the target image's migration manifest is compared against the
# applied set in the database. An image may only boot when the applied set
# is a strict prefix of its manifest. The rollback path is gated too: an
# old image is never rolled onto a schema it does not know — the database
# schema moves with the release, so a failed release that already migrated
# the database is NOT rolled back; the operator restores from a PITR backup
# instead. SKIP_MIGRATION_GATE=1 disables the check.
#
# Release flow (migrate-before-roll, ADR-0061): the deploy workflow runs
# scripts/deploy/migrate.sh BEFORE this script, so the target image's
# migrations are applied explicitly with their own timeout budget. The
# gate below then guards the roll and the rollback decision; the boot-time
# gate (composition root) remains the final line of defense.
#
# Regression guard inherited from the original inline script: the rendered
# compose used to pin a literal tag, so a bump re-pulled and re-rolled the
# OLD image while the health poll below reported green. The per-service
# image check fails loudly unless every service runs the requested tag.

set -euo pipefail

source "$(dirname "$0")/migration-gate.sh"

TAG="${DOMINUS_TAG:?DOMINUS_TAG is required}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/dominus}"
SERVICES=(api worker scheduler)
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-30}"
HEALTH_POLL_SECONDS="${HEALTH_POLL_SECONDS:-5}"

log() { printf '%s\n' "$*"; }

die() { log "$*" >&2; exit 1; }

roll_and_verify() {
  local tag="$1"
  local svc expected actual
  sed -i "s|^DOMINUS_IMAGE_TAG=.*|DOMINUS_IMAGE_TAG=${tag}|" .env
  docker compose pull api worker scheduler
  docker compose up -d
  for svc in "${SERVICES[@]}"; do
    expected="ghcr.io/alessiobrillo/dominus:${tag}"
    [ "$svc" != "api" ] && expected="${expected}-${svc}"
    actual="$(docker inspect --format '{{.Image}}' "dominus-${svc}-1" 2>/dev/null || true)"
    if [ "$actual" != "$expected" ]; then
      log "expected ${svc} to run ${expected}, running ${actual}" >&2
      return 1
    fi
  done
}

wait_healthy() {
  local -i tries=HEALTH_ATTEMPTS
  while (( tries > 0 )); do
    if curl -fsS -o /dev/null "$HEALTH_URL"; then
      return 0
    fi
    tries=$((tries - 1))
    sleep "$HEALTH_POLL_SECONDS"
  done
  return 1
}

cd "$COMPOSE_DIR"

PREV_TAG="$(sed -n 's/^DOMINUS_IMAGE_TAG=//p' .env | tail -n 1 || true)"
if [ -z "${PREV_TAG:-}" ]; then
  die "DOMINUS_IMAGE_TAG is missing from ${COMPOSE_DIR}/.env — refusing to deploy"
fi

log "deploying ${TAG} (previous: ${PREV_TAG})"

# Gate the FORWARD roll: never roll an image that cannot understand the
# current schema. This also refuses explicit downgrades (deploying an
# older tag than what the database already reflects).
if ! migration_gate "$(gate_image_ref "$TAG")" "$COMPOSE_DIR"; then
  die "migration gate blocked the deploy of ${TAG} — no images were rolled. " \
    "Restore from a PITR backup or re-deploy a compatible release " \
    "(SKIP_MIGRATION_GATE=1 only if the schema state is known)."
fi

if roll_and_verify "$TAG" && wait_healthy; then
  log "api healthy on ${TAG} after roll"
  gate_write_state "$COMPOSE_DIR" || true
  exit 0
fi

if [ "$PREV_TAG" != "$TAG" ]; then
  log "rollout of ${TAG} failed; rolling back to ${PREV_TAG}" >&2
  # Gate the ROLLBACK: if the failed release already migrated the database,
  # the previous image cannot boot against it. The rollback is refused and
  # the operator restores from a PITR backup. Legacy pre-gate images are
  # checked against .schema-state (last green applied count).
  if ! migration_gate "$(gate_image_ref "$PREV_TAG")" "$COMPOSE_DIR"; then
    log "ROLLBACK BLOCKED BY MIGRATION GATE — ${PREV_TAG} cannot boot against " \
      "the current schema. Do NOT start the old image; restore the database " \
      "from a PITR backup, then re-deploy the failed release." >&2
    exit 1
  fi
  if roll_and_verify "$PREV_TAG"; then
    if wait_healthy; then
      log "rolled back to ${PREV_TAG}; api healthy — release ${TAG} did not ship" >&2
    else
      log "rolled back to ${PREV_TAG} but api is still unhealthy — manual intervention required" >&2
    fi
  else
    log "ROLLBACK FAILED — the previous image could not be restored; manual intervention required" >&2
  fi
  exit 1
fi

die "rollout of ${TAG} failed and there is no previous tag to restore"
