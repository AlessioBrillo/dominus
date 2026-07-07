import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

const SCORING_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS scoring_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  run_id TEXT NOT NULL,
  expected_value REAL NOT NULL,
  confidence REAL NOT NULL,
  suggested_buy_max REAL NOT NULL,
  suggested_list_price REAL NOT NULL,
  intrinsic_score REAL NOT NULL,
  commercial_score REAL NOT NULL,
  market_score REAL NOT NULL,
  expiry_score REAL NOT NULL,
  weighted_score REAL NOT NULL DEFAULT 0,
  recommended INTEGER NOT NULL DEFAULT 0,
  signal_scores TEXT NOT NULL,
  scored_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const SCORING_RUNS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_scoring_runs_candidate ON scoring_runs(candidate_id)
`;

export const name = '0002_create_scoring_runs';

export function up(db: Database.Database): void {
  db.exec(SCORING_RUNS_DDL);
  db.exec(SCORING_RUNS_INDEX_DDL);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, SCORING_RUNS_DDL);
  await execPg(db, SCORING_RUNS_INDEX_DDL);
}
