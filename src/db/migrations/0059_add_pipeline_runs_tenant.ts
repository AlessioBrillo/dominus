// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0059_add_pipeline_runs_tenant';
export const backwardCompatible = true;

/**
 * pipeline_runs.tenant_id: run history was a single shared list, so
 * GET /runs showed every tenant's runs and POST /runs/prune deleted them.
 * Additive and defaulted ('default'), so an older image that never writes the
 * column keeps working. No RLS here on purpose: system maintenance jobs
 * (prune, orphan reaping) run without a tenant context and must see all rows;
 * PipelineRunsRepository scopes tenant-facing reads in the query itself.
 */
export function up(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(pipeline_runs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'tenant_id')) {
    db.exec(`ALTER TABLE pipeline_runs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_tenant_started ON pipeline_runs(tenant_id, started_at DESC)`,
  );
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(
    `ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default'`,
  );
  await db.exec(
    `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_tenant_started ON pipeline_runs(tenant_id, started_at DESC)`,
  );
}

export function down(): void {}
