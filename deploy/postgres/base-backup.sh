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
# connection role with REPLICATION privilege. The cloud db node provisions
# a dedicated `backup` role (REPLICATION only, least privilege) — never
# reuse the app/owner role for backups.
#
# Off-host anchor (optional): set B2_BASE_REMOTE to an rclone remote path
# (e.g. b2:dominus-pitr/base/) and the base is copied there after the
# backup, then pruned with the same retention. A base backup that dies
# with the node is no PITR anchor at all (ADR-0054).
#
# WAL archive retention (optional): set B2_WAL_REMOTE (e.g.
# b2:dominus-pitr/wal/) and WAL_RETENTION_DAYS to prune the archived WAL
# segments (remote and the local $BACKUP_DIR/wal spool) that fall outside
# the recovery window. The archive must cover at least the base-backup
# retention minus one run (a restore replays WAL on top of the newest
# base), so keep WAL_RETENTION_DAYS <= PG_BASE_RETENTION_DAYS and leave
# margin for the daily cadence.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-backup}"
PG_PASSWORD="${PG_PASSWORD:-}"
PG_BASE_RETENTION_DAYS="${PG_BASE_RETENTION_DAYS:-14}"
WAL_RETENTION_DAYS="${WAL_RETENTION_DAYS:-7}"
WAL_DIR="${WAL_DIR:-${BACKUP_DIR}/wal}"
B2_BASE_REMOTE="${B2_BASE_REMOTE:-}"
B2_WAL_REMOTE="${B2_WAL_REMOTE:-}"

BASE_NAME="base-$(date -u +%Y%m%dT%H%M%SZ)"
DEST_DIR="${BACKUP_DIR}/${BASE_NAME}"
LOGPREFIX="base-backup:"

# A restore replays WAL on top of the newest surviving base backup: if the
# WAL retention were longer than the base retention it would simply waste
# storage, but shorter means segments still needed by an older base would
# be pruned — silently breaking PITR. Enforce the invariant.
if [ "${WAL_RETENTION_DAYS}" -gt "${PG_BASE_RETENTION_DAYS}" ]; then
  echo "${LOGPREFIX} FATAL WAL_RETENTION_DAYS (${WAL_RETENTION_DAYS}) > PG_BASE_RETENTION_DAYS (${PG_BASE_RETENTION_DAYS}): WAL needed to replay onto the newest surviving base would be pruned; refusing to continue" >&2
  exit 1
fi

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

# Push the anchor off-host when an rclone remote is configured: the local
# copy is a staging area, not a backup — a node loss must not lose the
# newest base. Prune the remote with the same retention as local.
if [ -n "${B2_BASE_REMOTE}" ]; then
  if ! command -v rclone >/dev/null 2>&1; then
    echo "${LOGPREFIX} WARN B2_BASE_REMOTE set but rclone is not installed; base stays local-only" >&2
  else
    echo "${LOGPREFIX} copying base to ${B2_BASE_REMOTE}"
    rclone copy "${DEST_DIR}" "${B2_BASE_REMOTE}"
    echo "${LOGPREFIX} pruning remote bases older than ${PG_BASE_RETENTION_DAYS}d"
    rclone delete --min-age "${PG_BASE_RETENTION_DAYS}d" "${B2_BASE_REMOTE}"
  fi
fi

# Prune base backups older than the retention window. The scheduler's
# pitr-health job alerts when the newest base backup passes 26h, so the
# retention must never drop below 2 days of history.
find "${BACKUP_DIR}" -maxdepth 1 -type d -name 'base-*' -mtime "+${PG_BASE_RETENTION_DAYS}" -exec rm -rf {} +

# Prune WAL segments outside the recovery window. Without this the WAL
# archive grows unbounded — on an idle node archive_timeout=300 still
# emits ~17MB/day, and B2 storage is billed per object. The remote prune
# must never remove segments still needed by the NEWEST surviving base,
# hence the assertion above: WAL_RETENTION_DAYS <= PG_BASE_RETENTION_DAYS.
if [ -n "${B2_WAL_REMOTE}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "${LOGPREFIX} pruning remote WAL older than ${WAL_RETENTION_DAYS}d (${B2_WAL_REMOTE})"
    rclone delete --min-age "${WAL_RETENTION_DAYS}d" "${B2_WAL_REMOTE}"
  else
    echo "${LOGPREFIX} WARN B2_WAL_REMOTE set but rclone is not installed; remote WAL not pruned" >&2
  fi
fi
if [ -d "${WAL_DIR}" ]; then
  echo "${LOGPREFIX} pruning local WAL older than ${WAL_RETENTION_DAYS}d (${WAL_DIR})"
  find "${WAL_DIR}" -maxdepth 1 -type f \( -name '[0-9A-F]*' -o -name '*.partial' \) \
    -mtime "+${WAL_RETENTION_DAYS}" -delete
fi

echo "${LOGPREFIX} done: ${DEST_DIR}"