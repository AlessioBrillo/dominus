import type Database from 'better-sqlite3';

export const name = '0032_create_pipeline_locks';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_locks (
      lock_name   TEXT    NOT NULL PRIMARY KEY,
      locked_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS pipeline_locks');
}
