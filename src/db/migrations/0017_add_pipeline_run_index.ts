import type Database from 'better-sqlite3';

export const name = '0017_add_pipeline_run_index';

export function up(db: Database.Database): void {
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='candidates'")
    .all() as { name: string }[];
  const existing = new Set(indexes.map((i) => i.name));

  if (!existing.has('idx_candidates_pipeline_run')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_candidates_pipeline_run
      ON candidates(pipeline_run_id)
    `);
  }
}
