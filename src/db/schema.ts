export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  migration_name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

export const CANDIDATES_DDL = `
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

export const CANDIDATES_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_candidates_domain ON candidates(domain)
`;

export const SCORING_RUNS_DDL = `
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
  weights_snapshot TEXT NOT NULL,
  scored_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

export const SCORING_RUNS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_scoring_runs_candidate ON scoring_runs(candidate_id)
`;

export const PORTFOLIO_ENTRIES_DDL = `
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

export const TRADEMARK_RESULTS_DDL = `
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

export const TRADEMARK_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_trademark_candidate ON trademark_results(candidate_id, source)
`;

export const TRADEMARK_TERM_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_trademark_term ON trademark_results(search_term, source)
`;
