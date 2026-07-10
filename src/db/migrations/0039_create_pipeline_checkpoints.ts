import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0039_create_pipeline_checkpoints';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_checkpoints (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT    NOT NULL,
      stage_name    TEXT    NOT NULL,
      passed_ids    TEXT    NOT NULL DEFAULT '[]',
      filtered_ids  TEXT    NOT NULL DEFAULT '[]',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),

      UNIQUE(run_id, stage_name)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_run
      ON pipeline_checkpoints(run_id)
  `);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(
    db,
    `
    CREATE TABLE IF NOT EXISTS pipeline_checkpoints (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT    NOT NULL,
      stage_name    TEXT    NOT NULL,
      passed_ids    TEXT    NOT NULL DEFAULT '[]',
      filtered_ids  TEXT    NOT NULL DEFAULT '[]',
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, stage_name)
    )
  `,
  );
  await execPg(
    db,
    `
    CREATE INDEX IF NOT EXISTS idx_pipeline_checkpoints_run
      ON pipeline_checkpoints(run_id)
  `,
  );
}
