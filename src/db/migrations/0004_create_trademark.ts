import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

const TRADEMARK_RESULTS_DDL = `
CREATE TABLE IF NOT EXISTS trademark_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER REFERENCES candidates(id),
  search_term TEXT NOT NULL,
  source TEXT NOT NULL,
  match_found INTEGER NOT NULL,
  match_details TEXT,
  raw_response TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
)
`;

const TRADEMARK_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_trademark_candidate ON trademark_results(candidate_id, source)
`;

export const name = '0004_create_trademark';

export function up(db: Database.Database): void {
  db.exec(TRADEMARK_RESULTS_DDL);
  db.exec(TRADEMARK_INDEX_DDL);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, TRADEMARK_RESULTS_DDL);
  await execPg(db, TRADEMARK_INDEX_DDL);
}
