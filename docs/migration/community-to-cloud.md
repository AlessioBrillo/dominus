# Community → DOMINUS Cloud migration guide

Moving from the self-hosted community edition (SQLite) to DOMINUS Cloud
(PostgreSQL) is a data move, not a rebuild: both editions read the same
schema (ADR-0027 "zero lock-in"). This guide walks the full path.

## Prerequisites

- A DOMINUS Cloud instance with a reachable PostgreSQL `DATABASE_URL`
  (the target schema must already exist — boot the Cloud stack once so
  `runMigrations()` creates it).
- The community SQLite file (`DATABASE_PATH`, default `./data/dominus.db`).
- The migration tools: `npm install` in a checkout of the repo.

Provisioning the Cloud instance: `deploy/terraform/` (Hetzner) creates the
two-node topology (app + PostgreSQL with PITR) and prints the public URL;
the `DATABASE_URL` used by the app equals
`postgres://dominus:<db_password>@10.0.0.3:5432/dominus` on the private
network — from an operator machine, port-forward or use the app node as a
jump host (`ssh -L 5432:10.0.0.3:5432 root@<app-ip>`). See
`deploy/terraform/README.md`.

## Step 1 — Export (source side, read-only)

```bash
npx tsx scripts/migrate-sqlite-to-pg.ts export ./data/dominus.db ./data/dominus-export.jsonl
# exported 12345 rows across 52 tables -> ./data/dominus-export.jsonl
```

The export opens the source database read-only and writes one JSON line
per table. It never touches the source.

## Step 2 — Import (target side, one transaction)

```bash
DATABASE_URL=postgres://user:pass@host:5432/dominus \
  npx tsx scripts/migrate-sqlite-to-pg.ts import ./data/dominus-export.jsonl
# imported 12345 rows across 52 tables (single transaction)
```

Notes:

- The import runs **inside a single transaction** — if any table fails,
  nothing is written and you can fix the blocker and re-run.
- Run it as the **table owner** (the app role in `DATABASE_URL`): RLS
  policies do not apply to the owner (ADR-0027/0047), so the bulk load is
  not filtered by tenant.
- SERIAL sequences are advanced automatically to `max(id)` so new app
  inserts cannot collide with migrated rows.

## Step 3 — Verify

```bash
DATABASE_URL=postgres://user:pass@host:5432/dominus \
  npx tsx scripts/migrate-sqlite-to-pg.ts verify ./data/dominus-export.jsonl
# verify: OK - all table row counts match the export
```

Exit code 1 lists per-table mismatches.

## Step 4 — Cut over

1. Stop the community instance (no writes during the cut over).
2. Do steps 1–3 on the frozen database.
3. Point the Cloud instance at the imported database.
4. Optional: re-attribute single-user data to your Cloud tenant
   (relevant if the community DB predates multi-tenancy):
   ```sql
   UPDATE candidates SET tenant_id = '<your-cloud-tenant-id>';
   -- repeat for every table with a tenant_id column (see 0047)
   ```
5. Smoke-test: run one pipeline run, open the dashboard, check the
   scheduler/backup jobs in the admin panel.

## Rollback

If the Cloud instance does not behave, the community instance is still
on disk untouched — point it back at `DATABASE_PATH` and keep serving.
Nothing about the migration deletes or modifies the source database.

## Related

- ADR-0027 — SaaS architecture, multi-tenant database
- ADR-0054 — PITR backup strategy (the Cloud target keeps its own
  backups; the community backups stop mattering once data is migrated)
- `docs/deployment/README.md` — deployment and restore drills
