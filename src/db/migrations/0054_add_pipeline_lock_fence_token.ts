// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';
import { getLogger } from '../../logger.js';

export const name = '0054_add_pipeline_lock_fence_token';

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return info.some((c) => c.name === column);
}

export function up(db: Database.Database): void {
  if (!columnExists(db, 'pipeline_locks', 'fence_token')) {
    db.exec(`ALTER TABLE pipeline_locks ADD COLUMN fence_token TEXT`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_pipeline_locks_fence_token ON pipeline_locks(fence_token)`,
    );
  }
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  const colExists = await db.queryOne<{ exists: number }>(
    `SELECT 1 as exists FROM information_schema.columns WHERE table_name = 'pipeline_locks' AND column_name = 'fence_token'`,
  );
  if (!colExists?.exists) {
    await db.exec(`ALTER TABLE pipeline_locks ADD COLUMN fence_token TEXT`);
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_pipeline_locks_fence_token ON pipeline_locks(fence_token)`,
    );
  }
}

export function down(): void {
  // Removing columns is not reliably reversible in SQLite;
  // the down path is a no-op to preserve data integrity.
  const log = getLogger();
  log.warn('Migration 0054 down: column removal not performed to preserve data integrity');
}