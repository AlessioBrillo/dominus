// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';
import { getLogger } from '../../logger.js';

export const name = '0051_add_pipeline_lock_renewal_tracking';

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return info.some((c) => c.name === column);
}

export function up(db: Database.Database): void {
  if (!columnExists(db, 'pipeline_locks', 'renewed_count')) {
    db.exec(`ALTER TABLE pipeline_locks ADD COLUMN renewed_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columnExists(db, 'pipeline_locks', 'last_renewed_at')) {
    db.exec(`ALTER TABLE pipeline_locks ADD COLUMN last_renewed_at TEXT`);
  }
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  const renewedColExists = await db.queryOne<{ exists: number }>(
    `SELECT 1 as exists FROM information_schema.columns WHERE table_name = 'pipeline_locks' AND column_name = 'renewed_count'`,
  );
  if (!renewedColExists?.exists) {
    await db.exec(`ALTER TABLE pipeline_locks ADD COLUMN renewed_count INTEGER NOT NULL DEFAULT 0`);
  }
  const lastRenewedColExists = await db.queryOne<{ exists: number }>(
    `SELECT 1 as exists FROM information_schema.columns WHERE table_name = 'pipeline_locks' AND column_name = 'last_renewed_at'`,
  );
  if (!lastRenewedColExists?.exists) {
    await db.exec(`ALTER TABLE pipeline_locks ADD COLUMN last_renewed_at TEXT`);
  }
}

export function down(): void {
  // Removing columns is not reliably reversible in SQLite;
  // the down path is a no-op to preserve data integrity.
  const log = getLogger();
  log.warn('Migration 0037 down: column removal not performed to preserve data integrity');
}
