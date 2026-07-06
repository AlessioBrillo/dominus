import type Database from 'better-sqlite3';
import { getMigrations, getMigrationNames } from './migrations/registry.js';
import { PG_MIGRATIONS } from './provider/pg-migrations.js';

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
 * Validate that SQLite and PostgreSQL migration lists are in sync.
 * Returns an array of error messages (empty = all good).
 */
export function validateMigrationSync(): string[] {
  const sqliteNames = getMigrationNames();
  const pgNames = PG_MIGRATIONS.map((m) => m.name).sort();

  const errors: string[] = [];

  for (const name of sqliteNames) {
    if (!pgNames.includes(name)) {
      errors.push(`SQLite migration '${name}' is missing from PG_MIGRATIONS in pg-migrations.ts`);
    }
  }

  for (const name of pgNames) {
    if (!sqliteNames.includes(name)) {
      errors.push(`PG_MIGRATIONS entry '${name}' has no corresponding SQLite migration file`);
    }
  }

  return errors;
}
