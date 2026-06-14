import type Database from 'better-sqlite3';

export const name = '0018_create_pipeline_metrics';

export function up(db: Database.Database): void {
  db.exec(`
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
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_run
      ON pipeline_metrics(pipeline_run_id)
  `);
}
