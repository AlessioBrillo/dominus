import type Database from 'better-sqlite3';

const BACKTEST_SIGNALS_DDL = `
CREATE TABLE IF NOT EXISTS backtest_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  outcome_id INTEGER NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
  scoring_run_id TEXT NOT NULL,
  predicted_expected_value REAL NOT NULL,
  predicted_buy_max REAL NOT NULL,
  predicted_list_price REAL NOT NULL,
  predicted_confidence REAL NOT NULL,
  actual_sale_price_eur REAL NOT NULL,
  absolute_error_eur REAL NOT NULL,
  signed_error_eur REAL NOT NULL,
  confidence_bucket TEXT NOT NULL,
  acquisition_cost_eur REAL NOT NULL DEFAULT 0,
  total_renewal_cost_paid_eur REAL NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const BACKTEST_SIGNALS_OUTCOME_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_backtest_outcome ON backtest_signals(outcome_id)
`;

const BACKTEST_SIGNALS_DOMAIN_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_backtest_domain ON backtest_signals(domain)
`;

const BACKTEST_SIGNALS_UNIQUE_IDX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_backtest_outcome_run
  ON backtest_signals(outcome_id, scoring_run_id)
`;

export const name = '0007_create_backtest_signals';

export function up(db: Database.Database): void {
  db.exec(BACKTEST_SIGNALS_DDL);
  db.exec(BACKTEST_SIGNALS_OUTCOME_IDX_DDL);
  db.exec(BACKTEST_SIGNALS_DOMAIN_IDX_DDL);
  db.exec(BACKTEST_SIGNALS_UNIQUE_IDX_DDL);
}
