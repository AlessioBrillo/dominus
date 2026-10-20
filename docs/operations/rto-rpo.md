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

These four variables (`B2_BASE_REMOTE`, `B2_WAL_REMOTE`, `WAL_RETENTION_DAYS`,
`PG_BASE_RETENTION_DAYS`) are read by the **database node's** backup
shell scripts (`deploy/postgres/base-backup.sh`) and by its cloud-init
(`deploy/terraform/modules/db-node/`), not by the DOMINUS application. They
therefore belong in the db node's `backup.env` and are deliberately absent
from the root `.env.example`, which documents application configuration only.

## 3. Recovery runbook (condensed)

A recovery produces three different kinds of evidence, and they are not
interchangeable. Read this section before claiming that the PITR path
works:

| Level | What it is | What it proves | Automatable today |
|---|---|---|---|
| **1 — static inspection** | `restore-drill.mjs --pg-base <base-dir>` | the backup FILES are what they claim to be (layout, version, system identifier) | **yes** — runs anywhere, CI included |
| **2 — full rehearsal** | `restore-drill.mjs --pg-restore …` | the backup can be RESTORED, the WAL replays, the recovery finishes, the rows come back | **yes** — needs the db host |
| **3 — promotion** | pointing the app at the restored instance | the restored data is good enough to serve traffic | **no** — manual, operator-judged |

Level 1 is _not_ a restore. Level 2 is the **only** evidence that the
RTO in §1 is real: a green `--pg-base` check says nothing about whether
the restore takes 30 minutes or 4 hours, or whether it succeeds at all.
Level 3 stays manual on purpose — deciding to serve production traffic
from a restored database is a judgement call, not a scripted step.

### 3.1 Level 1 — static base-backup inspection

```bash
node scripts/restore-drill.mjs --pg-base /var/lib/postgresql/backups/base-20260812T040000Z
# restore-drill: OK - postgres base backup .../base-20260812T040000Z (PG 17, 2147483648 bytes)
# restore-drill: manifest - system 7411512345678901234, WAL start 0/2000028, start time 2026-08-12 04:00:00.123 UTC
```

It checks that the `pg_basebackup` output has the layout PostgreSQL
expects (`PG_VERSION`, `global/`, `pg_wal/`, `backup_label` or
`backup_manifest`) and reports the PostgreSQL version plus, when the
manifest is present, the system identifier and the WAL start location.

**What it does not prove**: that the backup restores, that the WAL
replays, or that the restored rows are the rows that were backed up. It
proves the file layout, not the data.

### 3.2 Level 2 — full point-in-time recovery rehearsal

```bash
# 1. the WAL segments must be LOCAL: the restore script's restore_command
#    is `cp <wal-dir>/%f %p`, it never talks to B2 itself. Pull the
#    off-host archive down first (b2:<bucket>/wal/ is the remote the
#    node ships to, see B2_WAL_REMOTE).
mkdir -p /var/lib/postgresql/backups/wal-restore
rclone copy b2:<bucket>/wal/ /var/lib/postgresql/backups/wal-restore/

# 2. the base backup: the directory pg_basebackup wrote on the node
#    (after a node loss, copy it back from b2:<bucket>/base/ into a
#    local directory first)
BASE=/var/lib/postgresql/backups/base-20260812T040000Z

# 3. the rehearsal
node scripts/restore-drill.mjs --pg-restore \
  --base "$BASE" \
  --wal /var/lib/postgresql/backups/wal-restore \
  --target-time "2026-08-12 09:30:00 UTC" \
  --expect-rows schema_migrations:57 \
  --expect-rows portfolio_entries:1204
# restore-drill: OK - postgres PITR rehearsal: recovery 41.2s, replay stopped at 0/16B3748 (2026-08-12 09:30:00.123456 UTC), verified schema_migrations=57, portfolio_entries=1204 (63.8s)
```

What the rehearsal does, in order:

- stages the base into a throwaway data directory and replays the WAL
  archive on top of it (`deploy/postgres/restore-base.sh`);
- **waits for the recovery to finish** — it polls `pg_is_in_recovery()`
  until the restored instance reports it is no longer in recovery
  (bounded by `--timeout`, default 300 s). A cluster that is still
  replaying WAL is not a restore;
- proves it is talking to the _restored_ instance by comparing the
  system identifier of the restored control file with the one in the
  base backup's manifest;
- compares the row counts with `--expect-rows` (a mismatch fails the
  drill); with no expectation given it runs the
  `SELECT count(*) FROM schema_migrations` smoke query and reports the
  number;
- stops the restored cluster and deletes the throwaway data directory —
  also when the drill fails, so it never leaves a server running.

Exit code 0 = green, 1 = red. The mode is opt-in: the default
invocation of the script touches no PostgreSQL at all. It runs on the db
node, where the PostgreSQL client tools and the restore script live.

### 3.3 Level 3 — promotion into production (manual)

No script promotes a restored cluster into production: that decision
needs an operator who looks at the data. The runbook itself:

1. **Stop writes**: stop the app (`docker compose stop api worker scheduler`)
   to freeze the WAL at a known point.
2. **Restore the base**: `bash deploy/postgres/restore-base.sh <base-dir> <wal-archive-dir> [recovery_target_time]`
   stages the chosen base into a fresh data directory and replays the
   archived WAL up to the chosen stop point. The base directory is an
   argument — pick the newest completed one on the node (the
   `pitr_health` manifest says which base is the newest anchor).
   Omitting the third argument replays every WAL segment still in the
   archive. The script leaves the recovered cluster running on
   127.0.0.1:55432 — read its log, and do not promote it before the data
   has been inspected.
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
| Unbound DNSSEC validation lost | false Available verdicts | immediate alert, investigate val-permissive-mode, restart Unbound |
| Unbound resolver down | DNS resolution fails | `DNS_UNBOUND_HEALTH_CHECK_ENABLED` fails fast at boot, restart Unbound sidecar |

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
