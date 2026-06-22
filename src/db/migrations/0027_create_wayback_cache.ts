import type Database from 'better-sqlite3';

export const name = '0027_create_wayback_cache';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wayback_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      domain_age REAL NOT NULL DEFAULT 0,
      wayback_snapshots INTEGER NOT NULL DEFAULT 0,
      cached_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_wayback_cache_expires
      ON wayback_cache(expires_at)
  `);
}

export function down(db: Database.Database): void {
  db.exec('DROP INDEX IF EXISTS idx_wayback_cache_expires');
  db.exec('DROP TABLE IF EXISTS wayback_cache');
}
