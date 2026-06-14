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

export const CANDIDATES_PIPELINE_RUN_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_candidates_pipeline_run
ON candidates(pipeline_run_id)
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
  signal_scores TEXT NOT NULL,
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

/**
 * Outcomes are real-world events recorded against portfolio domains. They feed
 * the future weight-retraining loop (vision §6, §9) and let the operator
 * answer "of the N domains I bought in 2024, how many sold, for how much,
 * after how long?". Most numeric/qualitative fields are optional: only the
 * event type and occurrence date are mandatory. A domain is identified by its
 * portfolio_entries row (FK) so that deleting a portfolio entry cascades
 * cleanly. We do NOT FK to `candidates`: outcomes outlive the candidate
 * evaluation cycle and belong to the portfolio, not the pipeline.
 */
export const OUTCOMES_DDL = `
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
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

export const OUTCOMES_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_outcomes_domain ON outcomes(domain)
`;

export const OUTCOMES_TYPE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_outcomes_type ON outcomes(type, occurred_at)
`;

/**
 * backtest_signals: immutable join of (scoring prediction, realised sale).
 * See ADR-0007 for the rationale; produced by the backtest engine (ADR-0008).
 *
 *  - `outcome_id`         FK to outcomes (sold) — the realised event.
 *  - `scoring_run_id`     the run_id of the scoring_runs row whose
 *                          `scored_at <= outcome.occurred_at` was the
 *                          last prediction available at decision time.
 *  - UNIQUE(outcome_id, scoring_run_id) keeps `buildSignals()` idempotent.
 */
export const BACKTEST_SIGNALS_DDL = `
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

export const BACKTEST_SIGNALS_OUTCOME_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_backtest_outcome ON backtest_signals(outcome_id)
`;

export const BACKTEST_SIGNALS_DOMAIN_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_backtest_domain ON backtest_signals(domain)
`;

export const BACKTEST_SIGNALS_UNIQUE_IDX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_backtest_outcome_run
  ON backtest_signals(outcome_id, scoring_run_id)
`;

/**
 * pipeline_runs: durable history of every pipeline execution. See ADR-0011.
 *
 * One row per orchestrator.run() invocation. The orchestrator produces
 * `stageSummary` and `totalDurationMs` today; this table captures them
 * durably so the operator can list, inspect, and prune past runs.
 *
 *  - `run_id`              PK, UUID text. The orchestrator generates it
 *                          before any row is written; other tables
 *                          reference it by value (no FK).
 *  - `started_at`          ISO-8601 UTC; the moment run() was called.
 *  - `finished_at`         ISO-8601 UTC; updated on completion.
 *  - `total_duration_ms`   wall-clock duration; mirrors
 *                          `PipelineResult.totalDurationMs`.
 *  - `stage_summary`       JSON: { [StageName]: { passed, filtered, durationMs } }.
 *  - `inputs`              JSON: { keywords, brandableNames, closeoutDomains, closeoutEntries counts }.
 *  - `results_summary`     JSON: { candidatesEvaluated, recommended, trademarkBlocked, unscored, errors }.
 *  - `host_version`        text: DOMINUS package.json version at run time.
 *  - `retained_until`      ISO-8601 UTC; used by prune() to bound the table size.
 *  - `error`               text; non-null when the run failed before completion.
 *
 * No FK to scoring_runs or candidates. The relationship is join-by-string
 * (`scoring_runs.run_id = pipeline_runs.run_id`), so a future prune of
 * pipeline_runs does not cascade into scoring history.
 */
export const PIPELINE_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id              TEXT PRIMARY KEY,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  total_duration_ms   INTEGER,
  stage_summary       TEXT NOT NULL DEFAULT '{}',
  inputs              TEXT NOT NULL DEFAULT '{}',
  results_summary     TEXT NOT NULL DEFAULT '{}',
  host_version        TEXT NOT NULL,
  retained_until      TEXT NOT NULL,
  error               TEXT
)
`;

export const PIPELINE_RUNS_STARTED_AT_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at
  ON pipeline_runs(started_at DESC)
`;

export const PIPELINE_RUNS_RETAINED_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_retained_until
  ON pipeline_runs(retained_until)
`;

/**
 * renewal_alerts: auto-generated reminders about portfolio domains that
 * need operator attention before they expire or change in value.
 *
 * One row per (domain, alert_type) — the alert engine upserts so repeated
 * runs don't flood the table. Each row tracks which channels were notified
 * and when the operator acknowledged it.
 */
export const RENEWAL_ALERTS_DDL = `
CREATE TABLE IF NOT EXISTS renewal_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  portfolio_entry_id INTEGER NOT NULL REFERENCES portfolio_entries(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL
    CHECK(alert_type IN ('renewal_imminent','renewal_critical','renewal_past_due','score_dropped')),
  severity TEXT NOT NULL
    CHECK(severity IN ('info','warning','critical')),
  message TEXT NOT NULL,
  details TEXT,
  acknowledged_at TEXT,
  notified_channels TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

export const RENEWAL_ALERTS_DOMAIN_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_renewal_alerts_domain
  ON renewal_alerts(domain)
`;

export const RENEWAL_ALERTS_UNACK_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_renewal_alerts_unack
  ON renewal_alerts(acknowledged_at)
`;

export const RENEWAL_ALERTS_UNIQUE_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_renewal_alerts_domain_type
  ON renewal_alerts(domain, alert_type)
`;

export const WATCHLIST_ENTRIES_DDL = `
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

export const WATCHLIST_CHECKED_AT_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_watchlist_checked_at
  ON watchlist_entries(last_checked_at)
`;

export const WATCHLIST_NOTIFIED_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_watchlist_notified
  ON watchlist_entries(notified)
`;

export const WEIGHT_SNAPSHOTS_DDL = `
CREATE TABLE IF NOT EXISTS weight_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now')),
  intrinsic REAL NOT NULL,
  commercial REAL NOT NULL,
  market REAL NOT NULL,
  expiry REAL NOT NULL,
  source TEXT NOT NULL
    CHECK(source IN ('init', 'manual', 'auto-tune', 'cli-override')),
  backtest_generated_at TEXT,
  sample_size INTEGER,
  notes TEXT
)
`;

export const WEIGHT_SNAPSHOTS_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_weight_snapshots_snapshot_at
  ON weight_snapshots(snapshot_at DESC)
`;

export const WEIGHT_SNAPSHOTS_SOURCE_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_weight_snapshots_source
  ON weight_snapshots(source)
`;
