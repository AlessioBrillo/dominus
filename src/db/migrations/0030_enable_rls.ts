import type Database from 'better-sqlite3';

export const name = '0030_enable_rls';

export function up(_db: Database.Database): void {
  // SQLite does not support Row-Level Security.
  // RLS policies are applied only in the PostgreSQL migration path
  // (src/db/provider/pg-migrations.ts).
  // This migration is a no-op placeholder to keep migration counters
  // in sync between SQLite and PostgreSQL.
}

export function down(_db: Database.Database): void {
  // No-op — RLS is PG-only and managed in pg-migrations.ts.
}
