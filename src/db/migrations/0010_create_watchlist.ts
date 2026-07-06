import type Database from 'better-sqlite3';

const WATCHLIST_ENTRIES_DDL = `
CREATE TABLE IF NOT EXISTS watchlist_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  tld TEXT NOT NULL,
  notes TEXT,
  last_checked_at TEXT,
  last_status TEXT,
  last_status_change TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const WATCHLIST_CHECKED_AT_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_watchlist_checked_at
  ON watchlist_entries(last_checked_at)
`;

const WATCHLIST_NOTIFIED_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_watchlist_notified
  ON watchlist_entries(notified)
`;

export const name = '0010_create_watchlist';

export function up(db: Database.Database): void {
  db.exec(WATCHLIST_ENTRIES_DDL);
  db.exec(WATCHLIST_CHECKED_AT_IDX_DDL);
  db.exec(WATCHLIST_NOTIFIED_IDX_DDL);
}
