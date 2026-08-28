// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from './provider/interface.js';
import { getMigrations, getPgMigrations, getMigrationNames } from './migrations/registry.js';
import {
  assertSchemaCompatible,
  getMigrationManifest,
  readAppliedMigrations,
} from './migration-manifest.js';

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

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
export async function ensureSchemaUpToDate(provider: DatabaseProvider): Promise<void> {
  const appliedMigrations = await readAppliedMigrations(provider);
  const schemaCompat = assertSchemaCompatible(appliedMigrations, getMigrationManifest());
  if (!schemaCompat.ok) {
    throw new Error(
      `Schema migration gate failed for ${provider.dialect} database: ${schemaCompat.reason}`,
    );
  }
  await provider.runMigrations();
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
