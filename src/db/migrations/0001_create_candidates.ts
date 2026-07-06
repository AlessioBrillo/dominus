import type Database from 'better-sqlite3';

const CANDIDATES_DDL = `
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  tld TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  dns_status TEXT,
  rdap_status TEXT,
  is_premium INTEGER NOT NULL DEFAULT 0,
  pipeline_run_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const CANDIDATES_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_candidates_domain ON candidates(domain)
`;

export const name = '0001_create_candidates';

export function up(db: Database.Database): void {
  db.exec(CANDIDATES_DDL);
  db.exec(CANDIDATES_INDEX_DDL);
}
