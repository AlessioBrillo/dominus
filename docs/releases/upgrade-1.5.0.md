# Upgrade to DOMINUS v1.5.0 "First Boot"

This guide covers upgrading a self-hosted DOMINUS Community edition from
v1.4.0 to v1.5.0. The Cloud edition follows the same migration path via
the PostgreSQL adapter (see [migration-policy.md](migration-policy.md)).

## What changed in v1.5.0

| Area | Change | Why |
|------|--------|-----|
| Migration lock | `ensureSchemaUpToDate` takes a cross-process advisory lock before applying DDL | api, worker and scheduler share one SQLite file; without a lock they can race on `schema_migrations` and fail with `SQLITE_BUSY` |
| Pre-migration backup | A `VACUUM INTO` snapshot is taken before every migration run on SQLite | A failed migration must always leave a restorable snapshot (fail-closed, not fail-open) |
| Compose ordering | `worker` and `scheduler` now `depends_on: api: condition: service_healthy` | Prevents worker/scheduler from booting before the API is ready on a fresh volume |
| `dominus doctor` | New command to diagnose config, DB integrity, schema vs manifest, DNS mode, trademark canary, backup age and disk space | One-command pre-flight check for operators |
| `npm run selfhost:up` | One-command start: generates `API_KEYS`, creates `data/`, brings up Compose + Unbound, waits for `/api/v1/health` | Zero-config first boot for new self-hosted installations |
| Version consistency gate | `check:release-consistency` refuses a `package.json` version older than the latest tag | Prevents accidental version regression (e.g. 1.4.0 → 1.0.0) |

## Before you upgrade

1. **Back up your database manually** (v1.5.0 will also take a pre-migration
   backup automatically, but take your own first):

   ```bash
   # Community edition (SQLite)
   dominus maintenance backup ./backups/pre-1.5.0-$(date +%Y%m%d).db

   # Or directly with sqlite3
   sqlite3 data/dominus.db ".backup ./backups/pre-1.5.0-$(date +%Y%m%d).db"
   ```

2. **Stop the running stack**:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.unbound.yml down
   ```

3. **Review the CHANGELOG** for v1.5.0 to confirm there are no
   breaking changes affecting your configuration.

## Upgrade steps

### Docker Compose (recommended)

```bash
# 1. Pull the new image (or rebuild from source)
git pull
git switch v1.5.0   # or the release tag you are deploying

# 2. Bring the stack up with the new image
docker compose -f docker-compose.yml -f docker-compose.unbound.yml up -d --build

# 3. Verify the API is healthy
curl -fsS http://127.0.0.1:3000/api/v1/health

# 4. Run the doctor check
dominus doctor
```

The `depends_on: api: condition: service_healthy` ordering ensures the
worker and scheduler wait for the API before booting. On a fresh volume,
migrations run once under the cross-process lock; subsequent boots are
no-ops.

### From source (no Docker)

```bash
git pull
git switch v1.5.0
npm ci
npm run build
# The migration gate runs automatically at boot and takes a pre-migration backup.
npm start
```

## Verification

After the upgrade, run:

```bash
# 1. Doctor check — all checks should be ok
dominus doctor

# 2. Doctor with JSON output (for automation/monitoring)
dominus doctor --json

# 3. Confirm pre-migration backups exist
ls -la data/backup/migrations/

# 4. Verify the pipeline still works
dominus score vintagecoffee.com
```

## Rollback

If something goes wrong after the upgrade:

1. **Stop the stack**:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.unbound.yml down
   ```

2. **Restore the pre-upgrade backup**:

   ```bash
   # The v1.5.0 pre-migration backup is in data/backup/migrations/
   cp data/backup/migrations/pre-migration-*.db data/dominus.db
   ```

   Or restore your own manual backup taken before the upgrade.

3. **Redeploy the previous image**:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.unbound.yml up -d
   ```

   The migration gate will refuse to boot an older image against a newer
   schema (fail-closed). If you restored the pre-v1.5.0 backup, the
   schema matches v1.4.0 and the v1.4.0 image will boot normally.

## Notes

- The pre-migration backup directory is `<BACKUP_DIR>/migrations/`
  (default: `./data/backup/migrations/`). Old backups are pruned after
  `BACKUP_RETENTION_DAYS` (default: 30).
- The migration lock is stored in the `pipeline_locks` table and expires
  after 5 minutes. If a migration crashes mid-run, the lock expires and
  the next boot can acquire it.
- The cross-process lock means only one of api/worker/scheduler migrates
  at a time. The others wait for the lock to be released.
