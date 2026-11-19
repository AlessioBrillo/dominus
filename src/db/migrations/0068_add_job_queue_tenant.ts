// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0068_add_job_queue_tenant';
export const backwardCompatible = true;

/**
 * The tenant that owns a queued job, as a column.
 *
 * Until now the tenant of a job lived only inside `payload_json`
 * (`payload.tenantId`), which made three things impossible:
 *
 * 1. **Fairness.** A per-tenant cap on pending work cannot be expressed
 *    against a JSON blob, and the queue was global: one tenant could fill
 *    the whole queue and starve everyone else.
 * 2. **Erasure.** The data-subject deletion walks a table registry. The
 *    queue tables were not in it, so a tenant's domains kept living in
 *    queued payloads after the account was deleted.
 * 3. **Scheduling.** The scheduler could not enumerate the tenants it has
 *    to run a job for, because there was no queryable tenant column.
 *
 * The column is nullable: platform-level jobs (backup, PITR health, the
 * weight tuner) belong to no tenant and stay global.
 */
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_job_queue_tenant_status ON job_queue(tenant_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_dead_letter_tenant ON dead_letter_jobs(tenant_id)',
];

/** Whether the table already carries the column (the migration is idempotent). */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

export function up(db: Database.Database): void {
  // Idempotent: the rollback leaves the columns behind (dropping a column
  // is destructive), so the migration must be able to run again.
  if (!hasColumn(db, 'job_queue', 'tenant_id')) {
    db.exec('ALTER TABLE job_queue ADD COLUMN tenant_id TEXT');
  }
  if (!hasColumn(db, 'dead_letter_jobs', 'tenant_id')) {
    db.exec('ALTER TABLE dead_letter_jobs ADD COLUMN tenant_id TEXT');
  }
  for (const ddl of INDEXES) db.exec(ddl);
}

export function down(db: Database.Database): void {
  // The columns stay: the rollback boots the previous image against the
  // new schema, and an extra column is harmless there. Dropping it would
  // be destructive.
  db.exec('DROP INDEX IF EXISTS idx_job_queue_tenant_status');
  db.exec('DROP INDEX IF EXISTS idx_dead_letter_tenant');
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec('ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS tenant_id TEXT');
  await db.exec('ALTER TABLE dead_letter_jobs ADD COLUMN IF NOT EXISTS tenant_id TEXT');
  for (const ddl of INDEXES) await db.exec(ddl);
}
