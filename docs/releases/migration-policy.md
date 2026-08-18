# Schema Migration Policy (Release Gate)

Status: **adopted** (v1.1.0)
Scope: DOMINUS Cloud (PostgreSQL) and community edition (SQLite)
Related: [ADR-0054 (PITR)](/docs/adr/README.md), [operations/RTO-RPO](rto-rpo.md)

## 1. The invariant

The applied migration set in the database must be a **strict prefix** of the
deploying image's migration manifest.

```
manifest  (image): 0001 0002 0003 ... 0053 [0054 ...]
applied     (db):  0001 0002 0003              ← OK (prefix)
                   0001 0002 0003 0054          ← ahead: old image must not boot
                   0001 0009 0002               ← out-of-order / foreign: refuse
```

Every runtime image ships its own manifest
(`src/db/migration-manifest-cli.ts`, compiled into `dist/`). The deploy gate
extracts it with `docker run --entrypoint node <image> dist/db/migration-manifest-cli.js --list`.

## 2. Why this exists

Migrations run at boot (composition-root), before health checks, and — since
ADR-0061 — explicitly *before* the roll on the deploy node
(`scripts/deploy/migrate.sh`), while the previous image is still serving. An
auto-rollback after a failed release boots the **previous** image against the
**post-release** schema. Before the gate (v1.1.0) that rollback was blind:
if the failed release had already migrated the database, the old code started
against a schema it did not understand — or, with destructive DDL, the data
was gone.

The gate makes both cases fail **closed**:

| Case | Behaviour |
|---|---|
| Release boots, migrates, then health fails | Rollback is **blocked** — restore from PITR backup, then re-deploy the fixed release |
| Release fails before booting (DB untouched) | Rollback proceeds normally |
| Explicit downgrade deploy (older tag) | **Blocked** before any roll |
| Database with unknown/foreign migrations | **Blocked** — divergent lineage, manual intervention |

Escape hatch: `SKIP_MIGRATION_GATE=1` (intentional operator override).

## 3. Additive-first rule

All new migrations must be **additive** — they may add, never remove or
rewrite. A migration is acceptable when the previous image can keep running
against the schema *after* the migration ran.

### 3.1 Always allowed

- `CREATE TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX`, `CREATE TYPE`
- `ALTER TABLE ... ADD COLUMN`
- `ALTER TABLE ... ADD CONSTRAINT` / `CREATE CONSTRAINT TRIGGER`
- New `ENUM` values (append-only)
- Default values on new columns

### 3.2 Forbidden unless explicitly reviewed

- `DROP TABLE <x>` without a matching `CREATE TABLE <x>` in the **same**
  migration (the idempotent-recreate pattern is allowed)
- `ALTER TABLE ... DROP COLUMN`
- `ALTER TABLE ... RENAME TO`
- `ALTER TABLE ... RENAME COLUMN`
- `ALTER COLUMN ... SET NOT NULL`
- `DELETE FROM` (irreversible data loss)

### 3.3 Reviewed overrides

A migration that must do one of the above carries

```ts
export const migration = {
  // Reviewed: this column never shipped to production.
  backwardCompatible: true,
};
```

and survives the CI scanner only when the exported object marks
`backwardCompatible: true`. The commit message must explain why the rollback
stays safe.

### 3.4 Historical allowlist

Migrations `0011`, `0015`, `0029`, `0036`, `0042`, `0049` predate this
policy and contain destructive DDL. They are allowlisted in
`scripts/check-migration-compat.mjs` (each entry documents what was done) so
the scanner is green on the existing repo while every **new** migration is
enforced.

## 4. Where the gate lives

| Layer | Mechanism |
|---|---|
| CI (PR) | `release-gate` job: `node scripts/check-migration-compat.mjs --test` (fixture suite + repo scan) refuses destructive DDL; behavior tests for the deploy gate and the migrate step |
| Boot | `composition-root` preflight: `assertSchemaCompatible(applied, manifest)` fails fatal before `runMigrations()` |
| Deploy | `scripts/deploy/migration-gate.sh` (sourced by `rollout.sh`): forward roll and rollback both gated; `.schema-state` records the applied count after every green deploy |
| Deploy | `scripts/deploy/migrate.sh` (explicit migrate-before-roll, ADR-0061): runs the target image's `dist/db/migrate-cli.js` against the live database with a dedicated `MIGRATE_TIMEOUT_SECONDS`; nonzero exit aborts the deploy before any roll |
| Local | `npm run check:migration-compat` |

## 5. Operational runbook

**Symptom A:** deploy output shows `migration gate blocked the deploy of <tag>`
or `ROLLBACK BLOCKED BY MIGRATION GATE`.

1. **Do not** start the old image (`DOMINUS_IMAGE_TAG` back-revert is exactly
   what the gate blocks). Do not run manual SQL against the database.
2. Diagnose:
   - `ssh app-node` → `docker compose exec -T postgres psql -U dominus -d dominus \
     -tAc 'SELECT migration_name FROM schema_migrations ORDER BY id'`
   - Compare with `docker run --rm --entrypoint node <image> dist/db/migration-manifest-cli.js --list`
3. If the database is **ahead** of the image (release migrated, then failed):
   restore the database from a PITR backup (newest base + WAL replay, see
   [operations/RTO-RPO](rto-rpo.md)) or — preferred — deploy the **fixed**
   release that contains the same migrations instead of restoring.
4. Only when the schema state is fully understood may an operator set
   `SKIP_MIGRATION_GATE=1` for a single rollout; record it in the deploy log.

**Symptom B:** deploy output shows `schema migrations failed` or
`migration timed out` from `migrate.sh` (the migrate-before-roll step).

1. The deploy has **already aborted** — no image was rolled, the previous
   image is still serving, and the database may be partially migrated. Do
   not re-run the deploy blindly.
2. Diagnose (same queries as Symptom A): list `schema_migrations` and
   compare with the target image's manifest. A partial migration is usually
   visible as a gap at the tail of the applied set.
3. Migrations are additive-only (§3), so the old image can keep serving
   against the partially applied schema while the failure is investigated.
   Preferred fix: deploy the **fixed** release containing the same migration
   set, letting the migrate step complete the tail.
4. If the failed migration wrote irreversible data, restore from a PITR
   backup (newest base + WAL replay, see [operations/RTO-RPO](rto-rpo.md)).
5. A timeout (`migration timed out after <MIGRATE_TIMEOUT_SECONDS>s`) means
   the migrate container was killed; inspect the killed container's logs
   (`docker logs <container>`) before retrying.

## 6. FAQ

- **Why is `DROP TABLE` + `CREATE TABLE` (recreate) allowed?** The pair is
  idempotent and self-consistent: both the old and the new image see a table
  with the recreated shape. It is still discouraged — prefer `ADD COLUMN`.
- **Why not flag `DROP INDEX`?** Indexes are rebuildable artifacts; dropping
  one degrades performance but never breaks the previous image's SQL.
- **What about the SQLite community edition?** The same policy applies;
  `runMigrations()` in `migrator.ts` is the single shared path, and the boot
  preflight runs for both dialects.
- **What if a hotfix must remove a column urgently?** Two-step: release N
  stops writing the column (additive), release N+1 drops it with
  `backwardCompatible: true` and a migration-policy note.
