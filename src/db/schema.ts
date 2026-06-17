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
  weighted_score REAL NOT NULL DEFAULT 0,
  recommended INTEGER NOT NULL DEFAULT 0,
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

/**
 * job_queue: durable job queue for async pipeline execution.
 * See ADR-0023 for architecture.
 *
 *  - `job_type`          Discriminator: 'PIPELINE_RUN' | 'PORTFOLIO_RESCORE' | 'BACKTEST_BUILD' | 'BACKUP' | 'PRUNE' | 'WATCHLIST_POLL' | 'RENEWAL_CHECK'
 *  - `payload_json`      JSON payload specific to job_type
 *  - `status`            'queued' | 'running' | 'completed' | 'failed' | 'dead_letter'
 *  - `priority`          Higher = more urgent (user jobs > scheduled jobs)
 *  - `attempts`          Number of processing attempts
 *  - `max_attempts`      Max retries before dead letter (default: default 3
 *  - `scheduled_at`      When the job should run (for delayed/scheduled jobs)
 *  - `started_at`        When worker started processing
 *  - `finished_at`       When job completed/failed
 *  - `error`             Error message if failed
 *  - `result_json`       JSON result on completion
 */
export const JOB_QUEUE_DDL = `
CREATE TABLE IF NOT EXISTS job_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'dead_letter')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

export const JOB_QUEUE_STATUS_PRIORITY_SCHEDULED_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_job_queue_status_priority_scheduled
  ON job_queue(status, priority DESC, scheduled_at)
`;

export const JOB_QUEUE_JOB_TYPE_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_job_queue_job_type
  ON job_queue(job_type)
`;

export const JOB_QUEUE_CREATED_AT_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_job_queue_created_at
  ON job_queue(created_at DESC)
`;

/**
 * dead_letter_jobs: jobs that exceeded max_attempts.
 * Preserves full payload for manual inspection/replay.
 */
export const DEAD_LETTER_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_job_id INTEGER NOT NULL,
  job_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  failed_at TEXT NOT NULL DEFAULT (datetime('now')),
  original_created_at TEXT NOT NULL
)
`;

export const DEAD_LETTER_JOB_TYPE_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_dead_letter_job_type
  ON dead_letter_jobs(job_type)
`;

export const DEAD_LETTER_FAILED_AT_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_dead_letter_failed_at
  ON dead_letter_jobs(failed_at DESC)
`;

/**
 * provider_cache: durable cache for third-party provider responses (RDAP, WHOIS, trademark).
 *
 * Columns:
 *  - `cache_key`       Unique key per cache entry (e.g. domain name).
 *  - `provider_name`   Identifies which provider generated the value.
 *  - `value`           Cached JSON payload.
 *  - `expires_at`      ISO-8601 TTL; cache is stale past this point.
 */
export const PROVIDER_CACHE_DDL = `
CREATE TABLE IF NOT EXISTS provider_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
)
`;

export const PROVIDER_CACHE_LOOKUP_IDX_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_cache_lookup
  ON provider_cache(cache_key, provider_name)
`;

export const PROVIDER_CACHE_EXPIRES_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_provider_cache_expires
  ON provider_cache(expires_at)
`;

/**
 * scheduler_jobs: persisted definition of each cron-like scheduled job.
 *
 * Columns:
 *  - `job_name`            Primary key, e.g. "weight-tune", "backup", "renewal-check".
 *  - `cron_expression`     cron schedule string.
 *  - `enabled`             0/1 — disabled jobs are skipped by the scheduler loop.
 *  - `last_run_at`         ISO-8601 of most recent execution attempt.
 *  - `last_result`         Free-text summary returned by the job handler.
 *  - `last_duration_ms`    Wall-clock duration of the most recent run.
 *  - `consecutive_failures` Counter; used by the scheduler to alert on repeated failures.
 */
export const SCHEDULER_JOBS_DDL = `
CREATE TABLE IF NOT EXISTS scheduler_jobs (
  job_name        TEXT PRIMARY KEY,
  cron_expression TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     TEXT,
  last_result     TEXT,
  last_duration_ms INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

export const SCHEDULER_JOBS_ENABLED_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_enabled
  ON scheduler_jobs(enabled)
`;

/**
 * pipeline_metrics: per-stage breakdown of pipeline execution.
 *
 * Each pipeline run emits one row per stage (candidate-generation,
 * dns-pre-filter, rdap-confirmation, scoring-stage, trademark-gate).
 * Used by the observability dashboard and backtest analysis.
 */
export const PIPELINE_METRICS_DDL = `
CREATE TABLE IF NOT EXISTS pipeline_metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_run_id TEXT    NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
  stage_name      TEXT    NOT NULL,
  passed          INTEGER NOT NULL DEFAULT 0,
  filtered        INTEGER NOT NULL DEFAULT 0,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  error           INTEGER NOT NULL DEFAULT 0,
  recorded_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pipeline_run_id, stage_name)
)
`;

export const PIPELINE_METRICS_RUN_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_run
  ON pipeline_metrics(pipeline_run_id)
`;

/**
 * outcome_scores: scoring snapshot at the time an outcome was recorded.
 *
 * Records the complete scoring vector (weighted_score, confidence,
 * expected_value, commercial_score, market_score, expiry_score) for
 * every outcome (sold / dropped / expired / renewed), enabling
 * after-the-fact accuracy analysis.
 */
export const OUTCOME_SCORES_DDL = `
CREATE TABLE IF NOT EXISTS outcome_scores (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  domain            TEXT    NOT NULL,
  outcome_type      TEXT    NOT NULL,
  recommended       INTEGER NOT NULL DEFAULT 0,
  weighted_score    REAL    NOT NULL DEFAULT 0,
  confidence        REAL    NOT NULL DEFAULT 0,
  expected_value    REAL    NOT NULL DEFAULT 0,
  actual_sale_price REAL,
  tld               TEXT    NOT NULL,
  scored_at         TEXT    NOT NULL,
  occurred_at       TEXT    NOT NULL,
  commercial_score  REAL    NOT NULL DEFAULT 0,
  market_score      REAL    NOT NULL DEFAULT 0,
  expiry_score      REAL    NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(domain, occurred_at)
)
`;

export const OUTCOME_SCORES_OCCURRED_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_outcome_scores_occurred
  ON outcome_scores(occurred_at DESC)
`;

export const OUTCOME_SCORES_TLD_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_outcome_scores_tld
  ON outcome_scores(tld)
`;

/**
 * bids: auction bids placed by the acquisition service.
 *
 * Each row tracks one bid from placement to resolution
 * (won / lost / cancelled / outbid). Scoring snapshots
 * (expected_value, confidence, suggested_buy_max) and the
 * trademark verdict at bid time are embedded for audit.
 */
export const BIDS_DDL = `
CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  venue TEXT NOT NULL,
  bid_amount_eur REAL NOT NULL,
  max_bid_eur REAL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','won','lost','cancelled','outbid')),
  won_price_eur REAL,
  expected_value_at_bid REAL,
  confidence_at_bid REAL,
  suggested_buy_max_at_bid REAL,
  trademark_clear_at_bid INTEGER,
  bid_placed_at TEXT NOT NULL DEFAULT (datetime('now')),
  auction_ends_at TEXT,
  resolved_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

export const BIDS_DOMAIN_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_bids_domain ON bids(domain)
`;

export const BIDS_STATUS_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_bids_status ON bids(status)
`;

export const BIDS_PLACED_AT_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_bids_placed_at ON bids(bid_placed_at)
`;
