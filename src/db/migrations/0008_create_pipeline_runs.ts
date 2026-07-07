import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

const PIPELINE_RUNS_DDL = `
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

const PIPELINE_RUNS_STARTED_AT_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_started_at
  ON pipeline_runs(started_at DESC)
`;

const PIPELINE_RUNS_RETAINED_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_retained_until
  ON pipeline_runs(retained_until)
`;

export const name = '0008_create_pipeline_runs';

export function up(db: Database.Database): void {
  db.exec(PIPELINE_RUNS_DDL);
  db.exec(PIPELINE_RUNS_STARTED_AT_IDX_DDL);
  db.exec(PIPELINE_RUNS_RETAINED_IDX_DDL);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, PIPELINE_RUNS_DDL);
  await execPg(db, PIPELINE_RUNS_STARTED_AT_IDX_DDL);
  await execPg(db, PIPELINE_RUNS_RETAINED_IDX_DDL);
}
