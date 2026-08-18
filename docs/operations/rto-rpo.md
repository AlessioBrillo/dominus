# Recovery Point / Recovery Time Objectives

Status: **documented** (v1.1.0)
Scope: DOMINUS Cloud — single-node topology (ADR-0026), PostgreSQL data store
Related: [releases/migration-policy.md](../releases/migration-policy.md), ADR-0054 (PITR)

## 1. The commitments

| Objective | Value | Condition |
|---|---|---|
| **RPO** (recovery point) | ≤ 24 h | guaranteed: daily base backup |
| **RPO** (recovery point) | ≤ 5 min | when `B2_WAL_REMOTE` WAL shipping is enabled |
| **RTO** (recovery time) | 30–60 min | manual runbook, healthy node, automated restore |
| **RTO worst case** | up to 4 h | node replacement (Terraform provisioning) required |

These are **documented targets**, not SLAs: DOMINUS Cloud is a single-node
deployment with no standby replica. A full node loss requires provisioning a
replacement before recovery starts.

## 2. What the stack protects

| Layer | Mechanism | Where |
|---|---|---|
| Logical backup | `pg_dump` via app scheduler (`SCHEDULER_BACKUP_CRON`, default 04:00) | Postgres `backups` volume |
| PITR base | `pg_basebackup` via `deploy/postgres/base-backup.sh` (host cron, daily) | `/backups` on db node + optional `B2_BASE_REMOTE` |
| WAL archive | `archive_mode=on`, archive inside PGDATA, `WAL_RETENTION_DAYS` (default 7) | Postgres data volume + optional `B2_WAL_REMOTE` |
| Verification | `pitr_health` scheduler job reads the base-backup manifest table | `pitr_health` table, alerting via Prometheus |
| Restore | `deploy/postgres/restore-base.sh` | manual runbook, see §3 |

Retention defaults: base backups 14 days (`PG_BASE_RETENTION_DAYS`), WAL
7 days (`WAL_RETENTION_DAYS`) — the archive always covers the newest base
minus one run. Sizing rule: `WAL_RETENTION_DAYS <= PG_BASE_RETENTION_DAYS`.

## 3. Recovery runbook (condensed)

1. **Stop writes**: stop the app (`docker compose stop api worker scheduler`)
   to freeze the WAL at a known point.
2. **Restore the base**: `bash deploy/postgres/restore-base.sh` — picks the
   newest completed base from the manifest (`pitr_health`), restores it, and
   replays archived WAL up to the chosen stop point (`RECOVERY_TARGET`).
3. **Verify**: `docker compose exec -T postgres psql -U dominus -d dominus -c
   'SELECT count(*) FROM schema_migrations;'` and spot-check a recent row.
4. **Redeploy**: roll the release tag whose manifest covers the restored
   schema — the migration gate (`docs/releases/migration-policy.md`) refuses
   any image that cannot boot against it.
5. **Validate data**: spot-check portfolio/outcomes and the job queue; the
   `pitr_health` manifest row for the restored backup is updated on the next
   scheduled base backup.

## 4. Failure-mode matrix

| Failure | Data exposure | Recovery path |
|---|---|---|
| App crash / bad release | none (WAL intact) | rollout gate + rollback or re-deploy |
| Postgres crash, node alive | ≤ 5 min (WAL) / ≤ 24 h (base only) | restart + restore |
| Node loss, local backups intact | node-dependent (single disk) | replace node, restore |
| Node loss + B2 shipping enabled | ≤ 5 min | provision node, pull base + WAL from B2 |
| Node loss, no B2 | backups lost with the node | PITR not possible — restore from pg_dump of last scheduler run |

B2 offsite shipping (`B2_BASE_REMOTE`, `B2_WAL_REMOTE`) is **strongly
recommended**; without it, a node failure destroys the recovery data and the
stack degrades to the daily `pg_dump` (RPO ≤ 24 h, backup on the same node).

## 5. Interaction with the migration gate

The migration gate and PITR are complementary, not redundant:

- The gate prevents the *common* failure (bad release boots, migrates, fails
  health) from escalating into a corrupted-schema rollback — no restore needed.
- PITR is the *uncommon* path: gate-blocked rollback, destructive DDL that
  escaped review, or data-level corruption.

When the rollback gate blocks, the runbook is: **restore from PITR, then
deploy the fixed release** — never boot the old image against the new schema.
