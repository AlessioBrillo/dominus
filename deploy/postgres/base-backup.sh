#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# DOMINUS — PostgreSQL base backup for point-in-time recovery (ADR-0054).
#
# A base backup is the PITR "anchor": without a recent one, the WAL
# archive alone cannot restore the database. Run this daily on the host
# (systemd timer or crontab) next to the built-in pg_dump backup:
#
#   crontab -e
#     30 4 * * * PG_HOST=127.0.0.1 PG_PASSWORD=<pgpass> \
#       /opt/dominus/deploy/postgres/base-backup.sh >> /var/log/dominus/base-backup.log 2>&1
#
# Requirements: postgresql-client (pg_basebackup) on the host, and a
# connection role with REPLICATION privilege (PG_USER=dominus works only
# if the app role was granted replication; otherwise create a dedicated
# `backup` role with `pg_basebackup`-friendly privileges).

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-dominus}"
PG_PASSWORD="${PG_PASSWORD:-}"
PG_BASE_RETENTION_DAYS="${PG_BASE_RETENTION_DAYS:-14}"

BASE_NAME="base-$(date -u +%Y%m%dT%H%M%SZ)"
DEST_DIR="${BACKUP_DIR}/${BASE_NAME}"
LOGPREFIX="base-backup:"

mkdir -p "${BACKUP_DIR}"
if [ -n "${PG_PASSWORD}" ]; then
  export PGPASSWORD="${PG_PASSWORD}"
fi

echo "${LOGPREFIX} starting ${BASE_NAME} (host=${PG_HOST}:${PG_PORT} user=${PG_USER})"

pg_basebackup \
  -h "${PG_HOST}" \
  -p "${PG_PORT}" \
  -U "${PG_USER}" \
  -D "${DEST_DIR}" \
  -X stream \
  --checkpoint=fast \
  --no-password \
  --progress

# Prune base backups older than the retention window. The scheduler's
# pitr-health job alerts when the newest base backup passes 26h, so the
# retention must never drop below 2 days of history.
find "${BACKUP_DIR}" -maxdepth 1 -type d -name 'base-*' -mtime "+${PG_BASE_RETENTION_DAYS}" -exec rm -rf {} +

echo "${LOGPREFIX} done: ${DEST_DIR}"