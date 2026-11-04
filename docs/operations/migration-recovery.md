# Migration recovery runbook

This runbook covers what to do when a DOMINUS schema migration fails or
leaves the database in an inconsistent state. It applies to both the
community edition (SQLite) and the Cloud edition (PostgreSQL).

## Symptoms

- `Schema migration gate failed` at application boot
- `Could not acquire migration lock` when starting api/worker/scheduler
- `SQLITE_BUSY` or duplicate-key errors on `schema_migrations` during boot
- Application crashes on startup after a deploy

## Principle: fail-closed, restore from backup

DOMINUS never boots against a schema it does not understand. If a
migration fails, the correct response is to **restore from a backup**,
not to force the gate open or run manual SQL.

## Step 1: Stop the affected services

Stop api, worker and scheduler so no new writes occur:

```bash
# Docker Compose
docker compose -f docker-compose.yml -f docker-compose.unbound.yml down

# systemd
systemctl stop dominus-api dominus-worker dominus-scheduler
```

## Step 2: Assess the state

Check which migrations are applied:

```bash
# SQLite community edition
sqlite3 data/dominus.db "SELECT migration_name FROM schema_migrations ORDER BY id"

# PostgreSQL Cloud edition
psql -U dominus -d dominus -tAc 'SELECT migration_name FROM schema_migrations ORDER BY id'
```

Compare against the image's manifest:

```bash
docker run --rm --entrypoint node <image> dist/db/migration-manifest-cli.js --list
```

If the database is **ahead** of the image (more migrations applied than
the image knows), you must either:
- Deploy the **fixed** release that contains the same migrations, or
- Restore from a backup taken before the failed migration.

If the database is **behind** the image (fewer migrations applied), the
next boot will apply the pending migrations under the migration lock.

## Step 3: Restore from a pre-migration backup

v1.5.0+ takes a `VACUUM INTO` backup before every migration run on
SQLite. The backups live in `<BACKUP_DIR>/migrations/` (default:
`./data/backup/migrations/`).

```bash
# List available pre-migration backups
ls -lt data/backup/migrations/

# Restore the most recent one
cp data/backup/migrations/pre-migration-*.db data/dominus.db
```

For PostgreSQL (Cloud), use the PITR backup path:

```bash
# See docs/deployment/README.md for the PITR restore procedure
deploy/postgres/restore-base.sh <base-dir> <archive-dir>
```

## Step 4: Verify the restored database

```bash
# SQLite integrity check
sqlite3 data/dominus.db "PRAGMA integrity_check"

# Confirm the schema matches a known version
sqlite3 data/dominus.db "SELECT migration_name FROM schema_migrations ORDER BY id"
```

Then run the doctor check:

```bash
dominus doctor
```

All checks should report `ok` (or `warn` for non-blocking items like
missing `API_KEYS` in development).

## Step 5: Redeploy

Once the database is restored to a consistent state, redeploy:

```bash
# Docker Compose
docker compose -f docker-compose.yml -f docker-compose.unbound.yml up -d

# The migration gate will apply any pending migrations under the lock,
# then the API, worker and scheduler will boot normally.
```

## Step 6: If the gate still refuses

If `ensureSchemaUpToDate` still refuses to boot after a restore:

1. **Do not** set `SKIP_MIGRATION_GATE=1` unless you fully understand the
   risk. The gate exists to prevent data loss.
2. Check that the restored backup matches an image version you can deploy.
3. If the schema is from an unknown lineage (manual SQL was run), you
   must export your data and import it into a fresh database.

## Prevention

The following v1.5.0 features reduce the likelihood of migration
failures:

- **Cross-process migration lock**: only one of api/worker/scheduler runs
  migrations at a time, preventing `SQLITE_BUSY` races on shared SQLite.
- **Pre-migration backup**: a `VACUUM INTO` snapshot is taken before
  every DDL run, so a failed migration is always restorable.
- **Compose ordering**: worker and scheduler wait for the API to be
  healthy before booting, preventing boot-time migration races on fresh
  volumes.

## Related

- [Upgrade guide v1.5.0](../releases/upgrade-1.5.0.md)
- [Migration policy](../releases/migration-policy.md)
- [Backup and operations (ADR-0054)](../adr/0054-pitr-backup-strategy.md)
