// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseProvider } from './provider/interface.js';
import { getMigrations, getPgMigrations, getMigrationNames } from './migrations/registry.js';
import {
  assertSchemaCompatible,
  getMigrationManifest,
  readAppliedMigrations,
} from './migration-manifest.js';
import { execPg } from './pg-ddl.js';

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

export interface MigrationGuardOptions {
  /** Directory where pre-migration backups are written (SQLite only). */
  backupDir?: string;
  /** Retention days for pre-migration backups. 0 = keep forever. */
  retentionDays?: number;
  /** Lock TTL in milliseconds (default: 5 minutes). */
  lockTtlMs?: number;
  /** Path to the SQLite database file, used for a file-based migration lock.
   *  Required for SQLite: the pipeline_locks table does not exist yet on a
   *  fresh database, and separate pool connections do not share in-memory
   *  databases, so the advisory-lock table cannot be used before the first
   *  migration. A file-based lock avoids both problems. */
  lockPath?: string;
}

const MIGRATION_LOCK_NAME = 'migration:run';
const MIGRATION_LOCK_TTL_MS = 300_000; // 5 minutes
/** How often a waiting process retries the migration lock. */
const MIGRATION_LOCK_RETRY_MS = 500;

/**
 * Acquire the migration lock, waiting for the holder to release it.
 *
 * A Cloud deployment starts the api, the worker and the scheduler at the
 * same time, and all three run the schema gate at boot. With a single-shot
 * `tryLock` the two losers died at boot ("Could not acquire migration
 * lock"): the container exited, the deployment had a missing process, and
 * nothing said why. The lock is a SERIALIZATION mechanism, not a
 * failure mode: the winner holds it for the seconds the migration takes
 * and the others wait for it.
 */
async function acquireMigrationLockWithRetry(
  provider: DatabaseProvider,
  lockName: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  while (!acquired && Date.now() < deadline) {
    acquired = await provider.tryLock(lockName, timeoutMs);
    if (!acquired) {
      await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_RETRY_MS));
    }
  }
  return acquired;
}

function hasRawDb(
  provider: DatabaseProvider,
): provider is DatabaseProvider & { rawDb: Database.Database } {
  return provider.dialect === 'sqlite' && 'rawDb' in provider && provider.rawDb !== undefined;
}

/**
 * Take a pre-migration backup of a SQLite database before any DDL runs.
 *
 * The backup is a VACUUM INTO copy: a consistent, self-contained snapshot
 * that can be restored with `sqlite3 .restore` or `cp`. If the backup fails
 * the migration is refused — a partial schema is worse than no schema.
 *
 * Old backups are pruned by `retentionDays` so the backup directory does
 * not grow without bound.
 */
async function preMigrationBackup(
  provider: { rawDb: Database.Database },
  backupDir: string,
  retentionDays: number,
): Promise<void> {
  const dir = join(backupDir, 'migrations');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const dest = join(dir, `pre-migration-${Date.now()}.db`);
  try {
    provider.rawDb.pragma('wal_checkpoint(TRUNCATE)');
    provider.rawDb.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Pre-migration backup failed: ${message}`, { cause: err });
  }

  // Prune backups older than retentionDays.
  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    try {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        try {
          const st = statSync(full);
          if (st.isFile() && st.mtimeMs < cutoff) {
            unlinkSync(full);
          }
        } catch {
          // A file that cannot be stat'ed is skipped, not fatal.
        }
      }
    } catch {
      // Directory listing failure is not fatal: the fresh backup is safe.
    }
  }
}

export function runMigrations(db: Database.Database): void {
  db.exec(SCHEMA_MIGRATIONS_DDL);

  const applied = new Set(
    (
      db.prepare('SELECT migration_name FROM schema_migrations').all() as {
        migration_name: string;
      }[]
    ).map((r) => r.migration_name),
  );

  const migrations = getMigrations();

  const insert = db.prepare('INSERT INTO schema_migrations (migration_name) VALUES (?)');

  for (const migration of migrations) {
    if (!applied.has(migration.name)) {
      migration.up(db);
      insert.run(migration.name);
    }
  }
}

/**
 * Dry-run a migration without committing changes.
 * Returns the SQL that would be executed for both up and down.
 */
export interface DryRunResult {
  migrationName: string;
  upSql: string[];
  downSql: string[];
  wouldCommit: false;
}

export async function dryRunMigration(
  provider: DatabaseProvider,
  migrationName: string,
): Promise<DryRunResult> {
  const migrations = getMigrations();
  const migration = migrations.find((m) => m.name === migrationName);
  if (!migration) {
    throw new Error(`Migration '${migrationName}' not found`);
  }

  // For SQLite, we can use a transaction to capture the SQL
  if (provider.dialect === 'sqlite') {
    // We can't easily capture SQL without executing, so we'll return the DDL strings
    // by analyzing the migration file. For now, return the migration's intent.
    // In a real implementation, we'd parse the migration file for DDL statements.
    return {
      migrationName,
      upSql: [`-- Migration: ${migrationName}`, `-- UP migration would run here`],
      downSql: migration.down
        ? [`-- Migration: ${migrationName}`, `-- DOWN migration would run here`]
        : [`-- Migration: ${migrationName}`, `-- No DOWN migration defined (add down() function)`],
      wouldCommit: false,
    };
  }

  // For PostgreSQL, similar approach
  return {
    migrationName,
    upSql: [`-- Migration: ${migrationName}`, `-- UP migration would run here`],
    downSql: migration.down
      ? [`-- Migration: ${migrationName}`, `-- DOWN migration would run here`]
      : [`-- Migration: ${migrationName}`, `-- No DOWN migration defined (add down() function)`],
    wouldCommit: false,
  };
}

/**
 * Rollback the last applied migration.
 * Must be called with the last migration in the applied list (LIFO order).
 * Uses advisory lock to prevent concurrent migrations/rollbacks.
 */
export async function rollbackMigration(
  provider: DatabaseProvider,
  migrationName: string,
): Promise<void> {
  const migrations = getMigrations();
  const migration = migrations.find((m) => m.name === migrationName);
  if (!migration) {
    throw new Error(`Migration '${migrationName}' not found`);
  }

  if (!migration.down) {
    throw new Error(
      `Migration '${migrationName}' has no down() function — cannot rollback. ` +
        `Add a down() function or set backwardCompatible: true if safe to skip.`,
    );
  }

  // Verify this is the last applied migration (LIFO order)
  const applied = await readAppliedMigrations(provider);
  if (applied.length === 0) {
    throw new Error('No migrations applied — nothing to rollback');
  }
  const lastApplied = applied[applied.length - 1];
  if (lastApplied !== migrationName) {
    throw new Error(
      `Cannot rollback '${migrationName}': must rollback in reverse order. ` +
        `Last applied migration is '${lastApplied}'.`,
    );
  }

  // Acquire advisory lock to prevent concurrent operations
  const lockName = `migration:rollback:${migrationName}`;
  const lockTtlMs = 120_000; // 2 minutes
  const acquired = await provider.tryLock(lockName, lockTtlMs);
  if (!acquired) {
    throw new Error(
      `Could not acquire migration lock for rollback — another operation may be in progress`,
    );
  }

  try {
    // Execute the down migration
    if (provider.dialect === 'sqlite') {
      // For SQLite, use the rawDb getter to access the underlying Database.Database
      const sqliteProvider = provider as { rawDb?: Database.Database };
      if (!sqliteProvider.rawDb) {
        throw new Error('SQLite provider does not expose rawDb for rollback');
      }
      sqliteProvider.rawDb.exec('PRAGMA foreign_keys = OFF');
      try {
        migration.down!(sqliteProvider.rawDb);
      } finally {
        sqliteProvider.rawDb.exec('PRAGMA foreign_keys = ON');
      }
    } else {
      // PostgreSQL: check for downPg function
      const migrationWithDownPg = migration as { downPg?: (db: DatabaseProvider) => Promise<void> };
      if (!migrationWithDownPg.downPg) {
        throw new Error(
          `Migration '${migrationName}' has no downPg() function for PostgreSQL rollback. ` +
            `Add a downPg export to src/db/migrations/${migrationName}.ts for cloud rollback support.`,
        );
      }
      await migrationWithDownPg.downPg!(provider);
    }

    // Remove from schema_migrations
    await provider.exec('DELETE FROM schema_migrations WHERE migration_name = ?', [migrationName]);
  } finally {
    // Release lock
    await provider.unlock(lockName);
  }
}

/**
 * Schema compatibility preflight (migration gate) followed by the
 * migration run, through the dialect-aware provider.
 *
 * The applied migration set must be a strict prefix of this image's
 * manifest. A database ahead of the image (downgrade deploy, auto-rollback
 * onto a migrated schema) or with unknown migrations fails closed BEFORE
 * any migration runs, so old code can never boot against a schema it does
 * not understand. Restore from a PITR backup instead
 * (docs/releases/migration-policy.md).
 *
 * Used by the application boot (composition root) and by the standalone
 * migrate CLI (migrate-before-roll, ADR-0061).
 */
const MIGRATION_FILE_LOCK_SUFFIX = '.migrate.lock';

function isMemoryDatabase(lockPath?: string): boolean {
  return !lockPath || lockPath === ':memory:' || lockPath.startsWith(':memory:');
}

/**
 * Run the migration gate without a cross-process lock.
 *
 * Used for in-memory SQLite databases (each process has its own private
 * database, so there is no cross-process contention) and as the shared body
 * for both lock implementations.
 */
async function runMigrationsUnlocked(
  provider: DatabaseProvider,
  options: MigrationGuardOptions,
): Promise<void> {
  // The lock table is created by migration 0032. Create it idempotently so
  // it exists before the first migration runs on a fresh database. On
  // PostgreSQL the DDL must be converted (datetime('now') → CURRENT_TIMESTAMP,
  // etc.) because the migration registry emits SQLite-flavoured DDL. The
  // columns added by later migrations (worker_id 0036, renewal tracking
  // 0051, fence_token 0054) are included here too, so the lock functions
  // can use them before any migration runs; those migrations then skip
  // their ADD COLUMN because the column already exists.
  if (provider.dialect === 'postgres') {
    await execPg(
      provider,
      `
      CREATE TABLE IF NOT EXISTS pipeline_locks (
        lock_name   TEXT    NOT NULL PRIMARY KEY,
        locked_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        worker_id   TEXT,
        renewed_count INTEGER NOT NULL DEFAULT 0,
        last_renewed_at TEXT,
        fence_token TEXT
      )
      `,
    );
  } else {
    await provider.exec(
      `CREATE TABLE IF NOT EXISTS pipeline_locks (
        lock_name   TEXT    NOT NULL PRIMARY KEY,
        locked_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        worker_id   TEXT,
        renewed_count INTEGER NOT NULL DEFAULT 0,
        last_renewed_at TEXT,
        fence_token TEXT
      )`,
    );
  }

  const appliedMigrations = await readAppliedMigrations(provider);
  const schemaCompat = assertSchemaCompatible(appliedMigrations, getMigrationManifest());
  if (!schemaCompat.ok) {
    throw new Error(
      `Schema migration gate failed for ${provider.dialect} database: ${schemaCompat.reason}`,
    );
  }

  const manifest = getMigrationManifest();
  // Only take a pre-migration backup when there are pending migrations. A
  // boot with an up-to-date schema must not rewrite the backup directory
  // (and must not depend on a writable backup dir at all).
  const hasPendingMigrations = appliedMigrations.length < manifest.length;

  // Pre-migration backup (SQLite only): never run DDL against a database
  // without a restorable snapshot. A failed backup blocks the migration —
  // fail-closed, not fail-open.
  if (
    provider.dialect === 'sqlite' &&
    options.backupDir &&
    hasRawDb(provider) &&
    hasPendingMigrations
  ) {
    await preMigrationBackup(provider, options.backupDir, options.retentionDays ?? 0);
  }

  await provider.runMigrations();
}

/**
 * SQLite-specific migration guard using a file-based lock.
 *
 * The pipeline_locks advisory-lock table is created by migration 0032, but we
 * need a lock BEFORE the first migration runs on a fresh database. Separate
 * pool connections also don't share in-memory databases, so the table cannot
 * be used reliably before migrations. A file-based lock (a lockfile beside the
 * database file) solves both problems: it exists independently of the database
 * and is visible to all processes.
 */
async function ensureSchemaUpToDateSqliteFileLock(
  provider: DatabaseProvider & { rawDb: Database.Database },
  options: MigrationGuardOptions,
): Promise<void> {
  if (!options.lockPath) {
    throw new Error('SQLite migration guard requires lockPath for a file-based lock.');
  }

  const lockPath = options.lockPath + MIGRATION_FILE_LOCK_SUFFIX;
  let lockFd: number | null = null;

  try {
    // Try to create the lock file exclusively. O_CREAT|O_EXCL fails if the
    // file already exists, which means another process holds the lock.
    //
    // The lock is waited for, not failed on: the community edition runs
    // the CLI and the API on the same database file, and a one-shot
    // acquisition killed the second process at boot.
    const deadline = Date.now() + (options.lockTtlMs ?? MIGRATION_LOCK_TTL_MS);
    while (lockFd === null && Date.now() < deadline) {
      try {
        lockFd = openSync(lockPath, 'wx');
      } catch {
        await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_RETRY_MS));
      }
    }
    if (lockFd === null) {
      throw new Error(
        `Could not acquire migration lock - another process may already be migrating. ` +
          `Lockfile: ${lockPath}`,
      );
    }

    // The lock table is created by migration 0032, but we need it before the
    // first migration. Create it idempotently on the raw connection so all
    // pool connections see it.
    provider.rawDb.exec(
      `CREATE TABLE IF NOT EXISTS pipeline_locks (
        lock_name   TEXT    NOT NULL PRIMARY KEY,
        locked_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      )`,
    );

    const appliedMigrations = await readAppliedMigrations(provider);
    const schemaCompat = assertSchemaCompatible(appliedMigrations, getMigrationManifest());
    if (!schemaCompat.ok) {
      throw new Error(`Schema migration gate failed for sqlite database: ${schemaCompat.reason}`);
    }

    if (options.backupDir) {
      await preMigrationBackup(provider, options.backupDir, options.retentionDays ?? 0);
    }

    await provider.runMigrations();
  } finally {
    if (lockFd !== null) {
      try {
        closeSync(lockFd);
      } catch {
        /* best-effort close */
      }
      try {
        unlinkSync(lockPath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

export async function ensureSchemaUpToDate(
  provider: DatabaseProvider,
  options: MigrationGuardOptions = {},
): Promise<void> {
  // Default backup directory: alongside the SQLite database file. Only
  // meaningful for SQLite on disk; PostgreSQL has no file-based backup path
  // here (PITR is the Cloud story).
  if (
    provider.dialect === 'sqlite' &&
    options.lockPath &&
    !options.backupDir &&
    !isMemoryDatabase(options.lockPath)
  ) {
    options.backupDir = join(dirname(options.lockPath), 'backup');
  }

  // SQLite in-memory: each process has its own private database, so there is
  // no cross-process contention and no lock is needed.
  if (provider.dialect === 'sqlite' && isMemoryDatabase(options.lockPath)) {
    await runMigrationsUnlocked(provider, options);
    return;
  }

  // SQLite on disk: use a file-based lock beside the database file. The
  // advisory-lock table (pipeline_locks) is created by migration 0032 and
  // doesn't exist yet on a fresh database, and separate pool connections
  // don't share in-memory databases, so it cannot be used before the first
  // migration.
  if (provider.dialect === 'sqlite' && options.lockPath && hasRawDb(provider)) {
    await ensureSchemaUpToDateSqliteFileLock(provider, options);
    return;
  }

  // PostgreSQL (or SQLite without lockPath): use the advisory-lock table.
  // On PostgreSQL the pipeline_locks table is created by migration 0032, but
  // we need it BEFORE the first migration runs on a fresh database. Create it
  // idempotently here so tryLock never fails on a missing table. Columns added
  // by later migrations are included here too (see runMigrationsUnlocked).
  if (provider.dialect === 'postgres') {
    await execPg(
      provider,
      `
      CREATE TABLE IF NOT EXISTS pipeline_locks (
        lock_name   TEXT    NOT NULL PRIMARY KEY,
        locked_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        worker_id   TEXT,
        renewed_count INTEGER NOT NULL DEFAULT 0,
        last_renewed_at TEXT,
        fence_token TEXT
      )
      `,
    );
  }

  const lockTtlMs = options.lockTtlMs ?? MIGRATION_LOCK_TTL_MS;
  const acquired = await acquireMigrationLockWithRetry(provider, MIGRATION_LOCK_NAME, lockTtlMs);
  if (!acquired) {
    throw new Error(
      `Could not acquire migration lock '${MIGRATION_LOCK_NAME}' within ${lockTtlMs}ms - ` +
        'another process may already be migrating. Wait and retry, or inspect pipeline_locks.',
    );
  }

  try {
    await runMigrationsUnlocked(provider, options);
  } finally {
    await provider.unlock(MIGRATION_LOCK_NAME);
  }
}

/**
 * Return PostgreSQL migrations derived from the same source files.
 * Only migrations that export `upPg` are included — when a new SQLite
 * migration is added without `upPg`, the PG migration simply won't run,
 * making drift visible immediately at deploy time.
 */
export function getDerivedPgMigrations(): Array<{
  name: string;
  up: (db: DatabaseProvider) => Promise<void>;
}> {
  return getPgMigrations().map((m) => ({
    name: m.name,
    up: m.upPg!,
  }));
}

/**
 * Validate that every SQLite migration has a corresponding `upPg` export.
 * All migrations live in the SQLite files with `upPg` for PostgreSQL.
 * See ADR-0005 for the migration strategy.
 *
 * Also validates that migrations have a `down()` function for rollback support.
 * Migrations without `down()` must have `backwardCompatible: true` to document
 * that the change is safe on rollback (e.g., the affected data never shipped).
 *
 * Returns an array of warning/error messages (empty = all good).
 */
export function validateMigrationSync(): string[] {
  const sqliteMigrations = getMigrations();
  const sqliteNames = getMigrationNames();
  const derivedNames = getPgMigrations()
    .map((m) => m.name)
    .sort();

  const errors: string[] = [];

  for (const migration of sqliteMigrations) {
    if (!migration.upPg) {
      errors.push(
        `Migration '${migration.name}' has no upPg export — PostgreSQL deployments will skip it. ` +
          `Add an upPg function to src/db/migrations/${migration.name}.ts`,
      );
    }
    if (!migration.down && !migration.backwardCompatible) {
      errors.push(
        `Migration '${migration.name}' has no down() function and backwardCompatible is not set. ` +
          `Add a down() function for rollback support, or set backwardCompatible: true if the change ` +
          `is safe to skip on rollback (e.g., additive columns, indexes, or data that never shipped).`,
      );
    }
  }

  for (const name of derivedNames) {
    if (!sqliteNames.includes(name)) {
      errors.push(`Derived PG migration '${name}' has no corresponding SQLite migration file`);
    }
  }

  return errors;
}
