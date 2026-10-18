#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
#
# DOMINUS — PostgreSQL point-in-time restore (ADR-0054).
#
# Restores a base backup and replays the WAL archive up to a target time.
# Run on the host; the restored cluster is started on a spare port so it
# can be inspected (and eventually promoted) without disturbing the
# running server. Do NOT start two servers on the same PGDATA.
#
# Usage:
#   restore-base.sh <base-dir> <wal-archive-dir> [recovery_target_time]
#
# Examples:
#   # Latest point in time (best effort replay of the full archive)
#   restore-base.sh /backups/base-20260812T040000Z /srv/dominus/pgdata/archive
#
#   # Up to a specific UTC timestamp: '2026-08-12 09:30:00 UTC'
#   restore-base.sh /backups/base-20260811T040000Z /srv/dominus/pgdata/archive \
#     '2026-08-12 09:30:00 UTC'
#
# The WAL archive lives in PGDATA/archive on the running server (see
# docker-compose.prod.yml); point WAL_ARCHIVE_DIR at that directory.

set -euo pipefail

BASE_DIR="${1:?usage: restore-base.sh <base-dir> <wal-archive-dir> [recovery_target_time]}"
WAL_ARCHIVE_DIR="${2:?usage: restore-base.sh <base-dir> <wal-archive-dir> [recovery_target_time]}"
TARGET_TIME="${3:-}"

PORT="${PG_RESTORE_PORT:-55432}"
DATA_DIR="${PG_RESTORE_DATA_DIR:-$(mktemp -d /tmp/dominus-restore.XXXXXX)}"
LOGPREFIX="restore-base:"

[ -f "${BASE_DIR}/PG_VERSION" ] || {
  echo "${LOGPREFIX} FATAL: ${BASE_DIR} is not a pg_basebackup output (no PG_VERSION)"
  exit 1
}

echo "${LOGPREFIX} staging base backup into ${DATA_DIR}"
cp -a "${BASE_DIR}/." "${DATA_DIR}/"

# A fresh instance must not inherit the old postmaster identity or WAL.
rm -f "${DATA_DIR}/postmaster.pid" "${DATA_DIR}/postmaster.opts"
rm -rf "${DATA_DIR}/pg_wal"
mkdir -p "${DATA_DIR}/pg_wal"

echo "${LOGPREFIX} configuring recovery (archive=${WAL_ARCHIVE_DIR} target=${TARGET_TIME:-replay-all})"
cat >> "${DATA_DIR}/postgresql.auto.conf" <<EOF
restore_command = 'cp ${WAL_ARCHIVE_DIR}/%f %p'
EOF
if [ -n "${TARGET_TIME}" ]; then
  echo "recovery_target_time = '${TARGET_TIME}'" >> "${DATA_DIR}/postgresql.auto.conf"
fi
touch "${DATA_DIR}/recovery.signal"

# Owned by the current user (or root). PostgreSQL refuses to run as root:
# re-home the tree to the postgres OS user if we are root on a Debian host.
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres "${DATA_DIR}"
  PG_RUN_USER="postgres"
else
  PG_RUN_USER="$(id -un)"
fi

echo "${LOGPREFIX} starting recovered cluster on port ${PORT}"
pg_ctl -D "${DATA_DIR}" -o "-p ${PORT}" -l "${DATA_DIR}/recovery.log" start -w -U "${PG_RUN_USER}"

echo "${LOGPREFIX} recovery in progress — check ${DATA_DIR}/recovery.log"
echo "${LOGPREFIX} cluster stays running on 127.0.0.1:${PORT}; stop it with:"
echo "  pg_ctl -D ${DATA_DIR} stop -U ${PG_RUN_USER}"
echo "${LOGPREFIX} once verified, re-point the app to this instance or use pg_ctl promote in a standby setup"