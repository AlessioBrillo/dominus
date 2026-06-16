import type Database from 'better-sqlite3';

export const name = '0022_create_job_queue';

export function up(db: Database.Database): void {
  db.exec(`
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
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_status_priority_scheduled
      ON job_queue(status, priority DESC, scheduled_at)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_job_type
      ON job_queue(job_type)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_created_at
      ON job_queue(created_at DESC)
  `);

  db.exec(`
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
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dead_letter_job_type
      ON dead_letter_jobs(job_type)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_dead_letter_failed_at
      ON dead_letter_jobs(failed_at DESC)
  `);
}

export function down(db: Database.Database): void {
  db.exec('DROP INDEX IF EXISTS idx_job_queue_status_priority_scheduled');
  db.exec('DROP INDEX IF EXISTS idx_job_queue_job_type');
  db.exec('DROP INDEX IF EXISTS idx_job_queue_created_at');
  db.exec('DROP TABLE IF EXISTS job_queue');
  db.exec('DROP INDEX IF EXISTS idx_dead_letter_job_type');
  db.exec('DROP INDEX IF EXISTS idx_dead_letter_failed_at');
  db.exec('DROP TABLE IF EXISTS dead_letter_jobs');
}
