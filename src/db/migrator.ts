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
 * Returns an array of error messages (empty = all good).
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
  }

  for (const name of derivedNames) {
    if (!sqliteNames.includes(name)) {
      errors.push(`Derived PG migration '${name}' has no corresponding SQLite migration file`);
    }
  }

  return errors;
}
