import type Database from 'better-sqlite3';
import {
  PIPELINE_RUNS_DDL,
  PIPELINE_RUNS_STARTED_AT_IDX_DDL,
  PIPELINE_RUNS_RETAINED_IDX_DDL,
} from '../schema.js';

/**
 * pipeline_runs: durable run history (ADR-0011).
 *
 * Forward-only: a new table + two indexes. No data is touched on existing
 * databases; the table starts empty and grows as `dominus run` is invoked.
 */

export const name = '0008_create_pipeline_runs';

export function up(db: Database.Database): void {
  db.exec(PIPELINE_RUNS_DDL);
  db.exec(PIPELINE_RUNS_STARTED_AT_IDX_DDL);
  db.exec(PIPELINE_RUNS_RETAINED_IDX_DDL);
}
