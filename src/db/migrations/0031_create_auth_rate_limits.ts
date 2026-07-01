import type Database from 'better-sqlite3';

export const name = '0031_create_auth_rate_limits';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_rate_limits (
      ip          TEXT    NOT NULL PRIMARY KEY,
      failures    INTEGER NOT NULL DEFAULT 0,
      reset_at    INTEGER NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS auth_rate_limits');
}
