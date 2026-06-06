// ADR-0007: backtest_signals schema for prediction-vs-reality audit

import type Database from 'better-sqlite3';
import {
  BACKTEST_SIGNALS_DDL,
  BACKTEST_SIGNALS_OUTCOME_IDX_DDL,
  BACKTEST_SIGNALS_DOMAIN_IDX_DDL,
  BACKTEST_SIGNALS_UNIQUE_IDX_DDL,
} from '../schema.js';

/**
 * Immutable audit table that joins scoring predictions to realised outcomes.
 *
 * One row per (outcome, scoring_run) pair. Written by the backtest engine
 * (see ADR-0008) at snapshot time. The UNIQUE(outcome_id, scoring_run_id)
 * index makes `buildSignals()` idempotent: re-running it never duplicates
 * rows.
 *
 * Forward-only: no backfill, no destructive change. Safe on existing
 * databases — we only create a new table + 3 indexes.
 */

export const name = '0007_create_backtest_signals';

export function up(db: Database.Database): void {
  db.exec(BACKTEST_SIGNALS_DDL);
  db.exec(BACKTEST_SIGNALS_OUTCOME_IDX_DDL);
  db.exec(BACKTEST_SIGNALS_DOMAIN_IDX_DDL);
  db.exec(BACKTEST_SIGNALS_UNIQUE_IDX_DDL);
}
