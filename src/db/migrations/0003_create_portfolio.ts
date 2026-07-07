import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

const PORTFOLIO_ENTRIES_DDL = `
CREATE TABLE IF NOT EXISTS portfolio_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL UNIQUE,
  tld TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  renewal_date TEXT NOT NULL,
  acquisition_cost REAL NOT NULL,
  renewal_cost REAL NOT NULL,
  registrar TEXT NOT NULL,
  current_score REAL,
  suggested_list_price REAL,
  verdict TEXT NOT NULL DEFAULT 'keep',
  verdict_reason TEXT,
  verdict_updated_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

export const name = '0003_create_portfolio';

export function up(db: Database.Database): void {
  db.exec(PORTFOLIO_ENTRIES_DDL);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, PORTFOLIO_ENTRIES_DDL);
}
