import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0042_add_job_heartbeat';

/**
 * Adds worker ownership + heartbeat tracking to job_queue so the reaper
 * (requeueStuck) can distinguish a dead worker from a job that is merely
 * slow but still alive, instead of reaping on elapsed time alone.
 */
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE job_queue ADD COLUMN locked_by TEXT');
  db.exec('ALTER TABLE job_queue ADD COLUMN heartbeat_at TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_heartbeat
      ON job_queue(status, heartbeat_at)
  `);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  const lockedByExists = await db.queryOne<{ exists: number }>(
    `SELECT 1 as exists FROM information_schema.columns WHERE table_name = 'job_queue' AND column_name = 'locked_by'`,
  );
  if (!lockedByExists?.exists) {
    await db.exec('ALTER TABLE job_queue ADD COLUMN locked_by TEXT');
  }
  const heartbeatExists = await db.queryOne<{ exists: number }>(
    `SELECT 1 as exists FROM information_schema.columns WHERE table_name = 'job_queue' AND column_name = 'heartbeat_at'`,
  );
  if (!heartbeatExists?.exists) {
    await db.exec('ALTER TABLE job_queue ADD COLUMN heartbeat_at TIMESTAMP');
  }
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_job_queue_heartbeat
      ON job_queue(status, heartbeat_at)
  `);
}

export function down(db: Database.Database): void {
  db.exec('DROP INDEX IF EXISTS idx_job_queue_heartbeat');
  db.exec('ALTER TABLE job_queue DROP COLUMN locked_by');
  db.exec('ALTER TABLE job_queue DROP COLUMN heartbeat_at');
}
