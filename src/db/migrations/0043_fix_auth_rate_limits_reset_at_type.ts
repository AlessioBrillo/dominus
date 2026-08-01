// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0043_fix_auth_rate_limits_reset_at_type';

/**
 * Migration 0031 declared `reset_at INTEGER` but src/api/middleware/auth.ts
 * has always written an ISO-8601 string to it. SQLite's manifest typing
 * tolerates this silently; PostgreSQL rejects it with "invalid input syntax
 * for type integer" on every INSERT/UPDATE, which breaks auth rate limiting
 * (fails open to a 500 instead of a 429) on any Postgres deployment.
 */
export function up(db: Database.Database): void {
  // No-op on SQLite: an INTEGER-affinity column already stores the ISO
  // string as TEXT when the value isn't numeric, so behavior is unaffected.
  db.exec('SELECT 1');
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, 'ALTER TABLE auth_rate_limits ALTER COLUMN reset_at TYPE TEXT');
}

export function down(db: Database.Database): void {
  db.exec('SELECT 1');
}
