#!/usr/bin/env bash
# DOMINUS Cloud — explicit schema migration step (migrate-before-roll,
# ADR-0061). Runs the TARGET image's migration CLI against the live
# database BEFORE the rollout, so slow DDL gets its own budget and can
# never trip the health poll of the roll phase.
#
# Uploaded to the app node and executed by .github/workflows/deploy.yml
# between the migration gate and the rollout. Runs from /opt/dominus (the
# stack directory); the target tag arrives via DOMINUS_TAG.
#
# The migrate container joins the stack's network and inherits the api
# service environment (DATABASE_URL, ...) from compose. The target image
# tag is forced through the DOMINUS_IMAGE_TAG shell variable, which takes
# precedence over .env for interpolation — the migrate step ALWAYS runs
# the NEW image, never the previous one.
#
# On failure or timeout NO image is rolled and the database may be
# mid-DDL: do NOT roll back blindly. The rollback gate in rollout.sh
# refuses to boot the previous image onto a schema it does not know —
# restore from a PITR backup instead (docs/releases/migration-policy.md).

set -uo pipefail

TAG="${DOMINUS_TAG:?DOMINUS_TAG is required}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/dominus}"
MIGRATE_TIMEOUT_SECONDS="${MIGRATE_TIMEOUT_SECONDS:-600}"
IMAGE="ghcr.io/alessiobrillo/dominus:${TAG}"

log() { printf '%s\n' "$*"; }
die() { log "$*" >&2; exit 1; }

cd "$COMPOSE_DIR"

log "pulling ${IMAGE}"
docker pull "$IMAGE"

log "running schema migrations from ${IMAGE} (budget: ${MIGRATE_TIMEOUT_SECONDS}s)"
cid="$(DOMINUS_IMAGE_TAG="${TAG}" docker compose run -d --no-deps \
  --entrypoint node api dist/db/migrate-cli.js 2>/dev/null | tail -n 1 || true)"
if [ -z "$cid" ]; then
  die "failed to start the migration container (image ${IMAGE})"
fi

wait_out="$(timeout "${MIGRATE_TIMEOUT_SECONDS}s" docker wait "$cid" 2>/dev/null)"
wait_rc=$?

if [ "$wait_rc" -eq 124 ]; then
  docker kill "$cid" >/dev/null 2>&1 || true
  docker wait "$cid" >/dev/null 2>&1 || true
  docker logs "$cid" 2>&1 | tail -n 50 || true
  docker rm -f "$cid" >/dev/null 2>&1 || true
  die "migrations timed out after ${MIGRATE_TIMEOUT_SECONDS}s — container killed. " \
    "The database may be mid-DDL; do NOT roll back blindly. " \
    "Restore from a PITR backup if needed."
fi

# `docker wait` exits with (and prints) the container's exit code.
if [ "$wait_rc" -ne 0 ]; then
  docker logs "$cid" 2>&1 | tail -n 50 || true
  docker rm -f "$cid" >/dev/null 2>&1 || true
  die "migrations failed (exit ${wait_out:-unknown}) — no images were rolled"
fi

docker logs "$cid" 2>&1 || true
docker rm -f "$cid" >/dev/null 2>&1 || true

log "schema is up to date for ${TAG}"