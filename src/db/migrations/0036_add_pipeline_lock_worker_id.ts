import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0036_add_pipeline_lock_worker_id';

export async function upPg(db: DatabaseProvider): Promise<void> {
  const colExists = await db.queryOne<{ exists: number }>(
    `SELECT 1 as exists FROM information_schema.columns WHERE table_name = 'pipeline_locks' AND column_name = 'worker_id'`,
  );
  if (!colExists?.exists) {
    await db.exec(`ALTER TABLE pipeline_locks ADD COLUMN worker_id TEXT`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_pipeline_locks_worker ON pipeline_locks(worker_id)`,
    );
  }
}

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_locks_v2 (
      lock_name   TEXT    NOT NULL PRIMARY KEY,
      locked_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT    NOT NULL,
      worker_id   TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_locks'")
    .get();
  if (existing) {
    const oldLocks = db
      .prepare('SELECT lock_name, locked_at, expires_at, created_at FROM pipeline_locks')
      .all() as {
      lock_name: string;
      locked_at: string;
      expires_at: string;
      created_at: string;
    }[];
    const insert = db.prepare(
      'INSERT OR IGNORE INTO pipeline_locks_v2 (lock_name, locked_at, expires_at, worker_id, created_at) VALUES (?, ?, ?, NULL, ?)',
    );
    for (const lock of oldLocks) {
      insert.run(lock.lock_name, lock.locked_at, lock.expires_at, lock.created_at);
    }
    db.exec('DROP TABLE pipeline_locks');
  }

  db.exec('ALTER TABLE pipeline_locks_v2 RENAME TO pipeline_locks');
}

export function down(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_locks_v1 (
      lock_name   TEXT    NOT NULL PRIMARY KEY,
      locked_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT    NOT NULL,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const oldLocks = db
    .prepare('SELECT lock_name, locked_at, expires_at, created_at FROM pipeline_locks')
    .all() as {
    lock_name: string;
    locked_at: string;
    expires_at: string;
    created_at: string;
  }[];
  const insert = db.prepare(
    'INSERT OR IGNORE INTO pipeline_locks_v1 (lock_name, locked_at, expires_at, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const lock of oldLocks) {
    insert.run(lock.lock_name, lock.locked_at, lock.expires_at, lock.created_at);
  }
  db.exec('DROP TABLE pipeline_locks');
  db.exec('ALTER TABLE pipeline_locks_v1 RENAME TO pipeline_locks');
}
