import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0014_create_scheduler_jobs';

export function up(db: Database.Database): void {
  db.exec(`
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
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_enabled
      ON scheduler_jobs(enabled)
  `);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(
    db,
    `
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
  `,
  );
  await execPg(
    db,
    `
    CREATE INDEX IF NOT EXISTS idx_scheduler_jobs_enabled
      ON scheduler_jobs(enabled)
  `,
  );
}
