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
#
# PITR manifest (optional): set PITR_MANIFEST_DATABASE (plus the
# HOST/PORT/USER/PASSWORD defaults) and each completed base backup is
# recorded in the pitr_health table (migration 0053), which the app's
# pitr-health scheduler job reads to judge the anchor age. The insert is
# best-effort — it must never fail the cron run.

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
# PITR manifest (migration 0053): record each completed base backup in the
# pitr_health table so the app's pitr-health scheduler job can judge the
# anchor age without filesystem access to this node. When
# PITR_MANIFEST_DATABASE is empty the manifest is skipped (default keeps
# standalone deployments unchanged).
PITR_MANIFEST_HOST="${PITR_MANIFEST_HOST:-${PG_HOST}}"
PITR_MANIFEST_PORT="${PITR_MANIFEST_PORT:-${PG_PORT}}"
PITR_MANIFEST_USER="${PITR_MANIFEST_USER:-dominus}"
PITR_MANIFEST_PASSWORD="${PITR_MANIFEST_PASSWORD:-}"
PITR_MANIFEST_DATABASE="${PITR_MANIFEST_DATABASE:-}"
PITR_MANIFEST_KEEP_ROWS="${PITR_MANIFEST_KEEP_ROWS:-14}"

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

case "${PITR_MANIFEST_KEEP_ROWS}" in
  *[!0-9]* | '')
    echo "${LOGPREFIX} FATAL PITR_MANIFEST_KEEP_ROWS must be a positive integer, got '${PITR_MANIFEST_KEEP_ROWS}'" >&2
    exit 1
    ;;
esac

# Record the completed base backup in the PITR manifest (migration 0053)
# so the app's pitr-health job can verify the anchor age without
# filesystem access to this node. Best-effort by design: the backup itself
# already succeeded, so a failed insert must not fail the cron run — it
# WARNs instead, and the scheduler's "no base backup recorded" alert will
# surface a persistent problem.
record_manifest() {
  if [ -z "${PITR_MANIFEST_DATABASE}" ]; then
    return 0
  fi
  if ! command -v psql >/dev/null 2>&1; then
    echo "${LOGPREFIX} WARN psql not found — PITR manifest row not recorded" >&2
    return 0
  fi
  if [ -z "${PITR_MANIFEST_PASSWORD}" ]; then
    echo "${LOGPREFIX} WARN PITR_MANIFEST_PASSWORD empty — PITR manifest row not recorded" >&2
    return 0
  fi

  local size_bytes host
  size_bytes=$(du -sb "${DEST_DIR}" | awk '{print $1}')
  host=$(hostname | tr -cd '[:alnum:].-')

  if ! PGPASSWORD="${PITR_MANIFEST_PASSWORD}" psql -v ON_ERROR_STOP=1 \
    -h "${PITR_MANIFEST_HOST}" -p "${PITR_MANIFEST_PORT}" \
    -U "${PITR_MANIFEST_USER}" -d "${PITR_MANIFEST_DATABASE}" \
    -v base_name="${BASE_NAME}" -v size_bytes="${size_bytes}" -v host="${host}" -v keep_rows="${PITR_MANIFEST_KEEP_ROWS}" \
    -c "INSERT INTO pitr_health (finished_at, base_name, size_bytes, host) VALUES (NOW(), :'base_name', :size_bytes, :'host'); DELETE FROM pitr_health WHERE id NOT IN (SELECT id FROM pitr_health ORDER BY finished_at DESC LIMIT :keep_rows);" >/dev/null 2>&1; then
    echo "${LOGPREFIX} WARN PITR manifest insert failed — check pitr_health grants (migration 0053)" >&2
    return 0
  fi
  echo "${LOGPREFIX} PITR manifest recorded: ${BASE_NAME} (${size_bytes} bytes)"
}

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

record_manifest

echo "${LOGPREFIX} done: ${DEST_DIR}"