# ADR-0054: Point-in-Time Recovery Backup Strategy

## Metadata

| Field          | Value                                  |
| -------------- | -------------------------------------- |
| **Status**     | Proposed                               |
| **Date**       | 2026-08-12                             |
| **Authors**    | AlessioBrillo                          |
| **Deciders**   | AlessioBrillo                          |
| **Supersedes** | N/A                                    |
| **Relates to** | ADR-0022, ADR-0027, ADR-0037, ADR-0051 |
| **Project**    | DOMINUS                                |

## Context

The Cloud stack (PostgreSQL) is backed up by a daily `pg_dump` custom
format dump (scheduler `backup` job, 04:00, `BackupService` →
`PostgresAdapter.backup`). That dump has an RPO of up to 24 hours: a
destructive event (bad migration, accidental delete, buggy write) that
happens at 04:01 is not recoverable before the next day's dump. For a
service that already meters usage, tracks billing state and stores
scoring verdicts, 24 hours of loss is the difference between a support
ticket and a data-loss incident.

Separately, backup *failures were silent*: the scheduler records
`isError` in `scheduler_job` (visible in the admin panel) but nothing
pushes an alert, and a dump that was never scheduled runs is invisible
until someone opens the panel.

The community edition (SQLite, `VACUUM INTO` dumps) keeps the daily dump
model — SQLite has no WAL archiving story that adds value at this scale,
and the single-user data is small. The PITR investment is a Cloud-only
concern.

## Decision Drivers

1. **RPO reduction without paid infrastructure** — the Cloud MVP runs on
   one VPS; the solution must be host-native (PostgreSQL features +
   shell), not a managed backup service.
2. **Alerting parity** — backup health must be observable through the
   existing Prometheus/Alertmanager stack, like every other failure mode.
3. **Operational simplicity** — the operator cron surface must stay tiny:
   one daily script + one restore script, both in `deploy/postgres/`.
4. **Honest failure scope** — PITR via WAL archiving protects against
   logical corruption; host death kills the archive with the database
   unless backups are shipped off-host. The ADR must not overclaim.

## Considered Options

### Option A: WAL archiving inside PGDATA + host base backups (chosen)

PostgreSQL runs with `archive_mode=on`, `archive_command` copying every
switched 16MB segment into `PGDATA/archive`, `archive_timeout=300` so
even an idle server archives at least every 5 minutes. A host cron runs
`deploy/postgres/base-backup.sh` (`pg_basebackup -X stream`) daily into
`/backups`, with retention. The app's `pitr-health` scheduler job
(PostgreSQL only) checks `pg_wal_lsn_diff(pg_current_wal_lsn(),
pg_last_archived_wal_lsn())` against a byte budget and the age of the
newest `base-*` directory, feeding `dominus_pitr_*` gauges. Restore
replays a base + the archive to a target time via
`deploy/postgres/restore-base.sh`.

**Pros**: zero extra services, RPO ≤ ~5 minutes, replay to any target
time, uses only pinned upstream images, alertable, testable in CI
(static base-backup check in `restore-drill --pg-base`).
**Cons**: WAL archive shares the DB disk (host death loses both — the
daily pg_dump remains the transportable artifact); archive grows with
write volume; replay requires manual verification on the host.

### Option B: pgBackRest / barman sidecar

Purpose-built backup managers with parallel archiving, checksums and
retention policies.

**Pros**: battle-tested, richer verification, handles the off-host ship
natively.
**Cons**: new containers/services, configuration surface, and a second
system to learn for a single-VPS deployment; the pinned-image supply
chain (ADR-0046) would need new images.

### Option C: Keep daily dumps only

Status quo.

**Pros**: zero new machinery.
**Cons**: RPO stays 24h; the entire reason for this ADR.

## Decision

Adopt Option A. PostgreSQL in the production overlay archives WAL into
`PGDATA/archive` (docker-compose.prod.yml), the host runs a daily
`pg_basebackup` (`deploy/postgres/base-backup.sh`), and the app gains:

- `PitrHealthService` — checks WAL lag and base-backup freshness; wired
  as the `pitr-health` scheduler job only when the provider dialect is
  `postgres` (SQLite community edition is untouched).
- `BackupService.onSuccess` → `dominus_backup_last_success_timestamp`
  gauge (closes the silent-failure hole for the daily dump).
- Prometheus rules: `BackupStale` (26h), `PitrArchivingDown`,
  `PitrWalLagHigh` (>64MB), `PitrBaseBackupStale` (>26h).
- `scripts/restore-drill.mjs --pg-base` static integrity check, and
  `docs/deployment/README.md` "Point-in-time recovery" section.

The community edition keeps the daily `VACUUM INTO` dump unchanged.

## Consequences

### Positive

- RPO drops from ≤24h to ≤ ~5min (archive_timeout) for the Cloud stack.
- Backup failures are no longer silent: the BackupStale rule fires on a
  failed *or skipped* daily dump, the Pitr rules fire when the archive
  or the base-backup anchor degrades.
- Operator surface stays minimal: two shell scripts, one cron line.

### Negative

- WAL archive lives inside PGDATA: it protects against logical
  corruption, not host death. Off-VPS durability still requires shipping
  the `backups` volume (Hetzner Volume + snapshot, or object storage).
- PITR replay is a manual host procedure (restore-base.sh) — no
  one-command automated failover.
- The `pitr-health` job adds one SQL + a few stat calls every 15 minutes
  on PostgreSQL deployments only.

### Compliance and Security Implications

No new credentials: `pg_basebackup` uses the existing PostgreSQL role
with REPLICATION privilege; the restore script runs on the host. The
archive holds the same data as the database — access control is the
PostgreSQL volume's existing protection.

### Migration and Monitoring Plan

`PITR_WAL_LAG_MAX_BYTES` (default 64MB) and
`PITR_BASE_BACKUP_MAX_AGE_HOURS` (default 26) tune the Pitr rules; the
daily base-backup cron and the `pg_dump` cron run at the same 04:00
window. The `restore-drill --pg-base` check is CI-testable; the full
replay drill is a release-checklist item on the host (documented in the
deployment guide).

### Validation

- `docker compose -f docker-compose.yml -f docker-compose.prod.yml
  config` parses with the archive_command block.
- `PitrHealthService` unit tests (lag budgets, missing base, SQLite
  no-op) in `src/scheduler/__tests__/pitr-health-service.test.ts`.
- `scripts/restore-drill.mjs --pg-base` against a staged
  `pg_basebackup` output.
- Live replay drill on the host: `restore-base.sh` to a timestamp,
  verify row counts, per the deployment guide.
