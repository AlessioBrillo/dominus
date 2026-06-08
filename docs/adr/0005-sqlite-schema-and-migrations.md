# ADR-0005: SQLite Schema and Migration Strategy

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted (retrospective) |
| **Date** | 2026-06-08 |
| **Authors** | AlessioBrillo |
| **Deciders** | AlessioBrillo |
| **Supersedes** | N/A |
| **Relates to** | ADR-0001, ADR-0007, ADR-0011 |
| **Project** | DOMINUS |

## Context

DOMINUS persists all data in SQLite. The schema must support six core tables:

- `candidates`: domains entering the pipeline, with status tracking through
  each stage.
- `scoring_runs`: scoring engine output per candidate per run, with a
  snapshot of the weights used.
- `portfolio_entries`: owned domains with acquisition cost, renewal date,
  current score, and drop verdict.
- `trademark_results`: USPTO/EUIPO API responses per search term, with
  TTL-based expiry for cache invalidation.
- `outcomes`: realised events (sold, dropped, expired, renewed) for the
  backtest feedback loop.
- `pipeline_runs`: durable history of every pipeline execution for audit
  and debugging.

A migration system is required to evolve the schema over time without data
loss. The migration strategy must be simple enough for a single-developer
project (no Flyway, no Knex migrations) but robust enough to apply
idempotently and document schema changes in version control.

SQLite-specific constraints driven by the single-user architecture also need
to be documented: WAL mode for concurrent read/write access, foreign key
enforcement via `PRAGMA`, and the absence of ALTER COLUMN support.

## Decision Drivers

1. **Simplicity** — the migration system must be a single file, not a library.
   Better-sqlite3's synchronous API makes this straightforward.
2. **Idempotence** — running migrations against an up-to-date database must
   be a no-op. This allows `npm start` to always run migrations without
   checking a version file.
3. **Version control** — every schema change is a numbered SQL DDL file
   committed with the code. The migration name matches the feature branch
   naming convention.
4. **Backward compatibility** — old code must not break against a newer
   schema (additive migrations only, no destructive DDL).
5. **SQLite-native** — the migration system must not hide SQLite behind an
   ORM. Raw SQL DDL in `.ts` files, executed by a `better-sqlite3`
   prepared statement.

## Considered Options

### Option A: Numbered DDL Constants + Idempotent Migration Runner (CHOSEN)

Each migration is a TypeScript file defining a DDL constant and an optional
seed statement. The migration runner compares the applied migrations against
the filesystem and applies only new ones.

Each DDL uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`
for idempotence. The runner tracks applied migrations in a
`schema_migrations` table.

**Advantages:**
- Ultra-simple: ~30 lines of TypeScript for the runner, plus one DDL file per
  migration. No dependencies beyond better-sqlite3.
- Idempotent by construction: `IF NOT EXISTS` means re-running all migrations
  is a no-op.
- Migration numbering is sequential and explicit: each migration file is
  `0001-candidates.ts`, `0002-scoring-runs.ts`, etc. The order is determined
  by sorting filenames, not a version table.
- Single-developer workflow: write the DDL, add the filename to the migration
  list, commit. No migration CLI, no up/down commands.

**Disadvantages:**
- No rollback: all migrations are additive (`CREATE TABLE`, `CREATE INDEX`).
  A destructive migration (DROP COLUMN, DELETE) would require a manual SQL
  script (and should never happen in normal operation).
- The `schema_migrations` table is not itself protected by transactions in
  early implementations — a crash between migration 4 and 5 could leave the
  database in a partial state. (Mitigated in the current runner by wrapping
  all migrations in a single transaction.)

**Cost Implications:** Zero monetary cost. ~4 hours to implement.

**Risk Assessment:** Very low. The system is trivial and has worked without
incident across 8 migrations.

---

### Option B: Knex.js Migration Framework

Use the Knex query builder's migration system, which supports `up()` and
`down()` functions, a migration CLI, and a lock table for concurrent
migration (irrelevant for single-user).

**Advantages:**
- Industry-standard migration system with rollback support.
- Mature and well-documented.
- Locking prevents concurrent migrations (not needed here).

**Disadvantages:**
- Adds a heavy dependency (Knex + its SQLite dialect) to a project that uses
  raw SQL for all other database access.
- Adds a migration CLI tool — the operator must learn Knex commands.
- Rollback is rarely used in practice for single-developer projects:
  destructive schema changes are typically handled by taking a backup and
  writing a new migration.
- Knex abstracts SQL syntax, which makes debugging harder — the operator
  must understand both Knex API and SQLite SQL.

**Cost Implications:** Zero monetary cost. ~12 hours to set up and 30KB added
dependency size. Introduces a SQL abstraction layer that contradicts the
design decision to use raw SQL.

**Risk Assessment:** Low, but introduces unnecessary abstraction and dependency
weight for no benefit at single-user scale.

---

### Option C: JSON File with Schema Version

Store a schema version number in a JSON file in `data/` and apply migrations
conditionally based on the version.

**Advantages:**
- No `schema_migrations` table in the database.
- Version is human-readable in a JSON file.

**Disadvantages:**
- The version file can get out of sync with the database (e.g., if the
  database is replaced but the version file persists).
- Two state locations (database + filesystem) doubles the surface for
  inconsistency.
- JSON file writes are not atomic on all filesystems — a crash during
  migration could corrupt the version file.
- No advantage over a `schema_migrations` table for a single-user tool.

**Cost Implications:** Zero monetary cost. Less robust than Option A.

**Risk Assessment:** Medium. The split-state problem (version file + database)
makes this strictly worse than a database-backed migration tracker.

---

## Decision

**Chosen option: Option A — Numbered DDL Constants + Idempotent Migration Runner**

The rationale is driven by the decision drivers:

1. **Simplicity**: The migration runner is 30 lines of TypeScript. Each
   migration is a DDL string in a dedicated file. No CLI, no framework, no
   lock table.

2. **Idempotence**: `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT
   EXISTS` make every migration idempotent by construction. The
   `schema_migrations` table prevents the runner from even attempting to
   execute already-applied migrations.

3. **Version control**: Migrations are numbered sequentially (`0001-`, `0002-`,
   etc.) and committed with the code. The schema is fully reconstructed by
   running all migrations against an empty database.

4. **Backward compatibility**: All 8 migrations are additive. No DROP, no
   ALTER COLUMN. Old code against a newer schema still works because new
   columns have defaults and new tables are never referenced by old code.

5. **SQLite-native**: Raw SQL DDL strings executed by `better-sqlite3.prepare()`.
   No ORM, no query builder, no abstraction layer.

The schema design decisions follow naturally:

- **WAL mode** (`PRAGMA journal_mode=WAL`): allows concurrent reads during
  writes in single-user mode. The `PipelineRunService` transaction writes to
  `candidates` and `scoring_runs` while the REST API may be reading
  `portfolio_entries` — WAL mode prevents lock contention.
- **Foreign keys** (`PRAGMA foreign_keys=ON`): enforced at the connection
  level, not as a schema DDL. This is safer for migration (a migration that
  creates a circular FK would fail immediately) and avoids the parsing issues
  that SQLite has with inline FK constraints in `CREATE TABLE`.
- **Text dates**: All timestamps are ISO-8601 text (`TEXT NOT NULL`). SQLite
  has no native datetime type; storing ISO-8601 text is human-readable,
  sortable, and compatible with `new Date(isoString)` and `strftime()`
  queries.

## Consequences

### Positive
- Migration runner is ~30 lines, understood at a glance.
- All 8 migrations are committed in version control with the schema they
  introduce. The full history is readable in `src/db/migrations/`.
- Idempotent: `runMigrations(db)` is safe to call on every `npm start`.
- No external dependency beyond better-sqlite3.

### Negative
- No rollback support. Destructive schema changes require a manual SQL script
  and are not represented as migrations. (Mitigation: destructive changes are
  rare and always preceded by a backup.)
- Migration files are raw SQL — no TypeScript type checking on DDL. A typo in
  a column name is caught only when the migration runs.
- The `schema_migrations` table stores only the migration name and timestamp.
  It does not store the DDL that was applied — reconstituting the schema
  requires reading all migration files.

### Compliance and Security Implications
- All SQL queries use parameterised statements (better-sqlite3 API enforces
  this). No SQL injection vector.
- The database file is stored at `DATABASE_PATH` (default `./data/dominus.db`),
  which is in the gitignored `data/` directory. The database is never
  committed to version control.
- WAL mode files (`.db-wal`, `.db-shm`) are gitignored and cleaned up by
  SQLite on clean shutdown.

### Migration and Monitoring Plan
- **Migration**: Eight migrations already applied. The `runMigrations()` call
  in `src/index.ts` runs on every `npm start` and is idempotent.
- **Adding a migration**: (1) Create `src/db/migrations/NNNN-description.ts`
  with a DDL constant, (2) add it to the migration list in
  `src/db/migrator.ts`, (3) run `npm run typecheck` to verify nothing broke,
  (4) commit.
- **Rollback**: There is no automated rollback. Manual rollback: restore from
  backup, or write a reverse migration SQL script. Backup before any
  migration that changes existing columns.

### Validation
- The migration runner is validated by tests in each repository file: each
  test creates an in-memory database, runs migrations, and asserts table
  structure via test queries.
- The `PipelineRunService` test validates that `pipeline_runs` rows are
  written correctly and respect the schema (ADR-0011).
- Production validation: `npm start` on a fresh install creates the database
  and applies all 8 migrations. `npm start` on an existing database is a
  no-op.

---

*This ADR was created following the MADR 4.0.0 standard. All DOMINUS ADRs
should be consistent with the product vision previously documented in
`dominus-product-vision.md` (v0.2), now superseded by this ADR series.
Template: `docs/adr/template.md`.*
