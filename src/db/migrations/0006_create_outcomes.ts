import type Database from 'better-sqlite3';

const OUTCOMES_DDL = `
CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL REFERENCES portfolio_entries(domain) ON DELETE CASCADE,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  sale_price_eur REAL,
  listing_price_eur REAL,
  days_listed INTEGER,
  venue TEXT,
  commission_pct REAL,
  acquisition_cost_eur REAL,
  total_renewal_cost_eur REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const OUTCOMES_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_outcomes_domain ON outcomes(domain)
`;

const OUTCOMES_TYPE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_outcomes_type ON outcomes(type, occurred_at)
`;

export const name = '0006_create_outcomes';

export function up(db: Database.Database): void {
  db.exec(OUTCOMES_DDL);
  db.exec(OUTCOMES_INDEX_DDL);
  db.exec(OUTCOMES_TYPE_INDEX_DDL);
}
