// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0061_create_automation_tables';
export const backwardCompatible = true;

/**
 * Post-acquisition automation tables (ADR-0083).
 *
 * `post_acquisition_steps` is the journal of the automated post-purchase
 * pipeline. One row per (domain, step, tenant): the unique index makes the
 * pipeline idempotent and resumable — a re-run updates the same row instead
 * of creating duplicates, and `attempts` counts executions.
 *
 * `automation_audit` records every automation action (run started, step
 * transitions, kill-switch refusals) so an operator can reconstruct what
 * the system did autonomously and why.
 *
 * Tenant isolation is repository-enforced (every query filters on
 * tenant_id) like the other post-1.0 tables; RLS policies cover the
 * entity tables listed in 0030_enable_rls / 0047_force_row_level_security.
 */
const STEPS_SQLITE = `
CREATE TABLE IF NOT EXISTS post_acquisition_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  step TEXT NOT NULL CHECK(step IN ('portfolio','site','indexing','dns','parking','listing')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','done','skipped','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'purchase',
  pipeline_run_id TEXT,
  detail_json TEXT,
  last_error TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(domain, step, tenant_id)
)
`;

const STEPS_PG = `
CREATE TABLE IF NOT EXISTS post_acquisition_steps (
  id SERIAL PRIMARY KEY,
  domain TEXT NOT NULL,
  step TEXT NOT NULL CHECK(step IN ('portfolio','site','indexing','dns','parking','listing')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','done','skipped','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'purchase',
  pipeline_run_id TEXT,
  detail_json TEXT,
  last_error TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(domain, step, tenant_id)
)
`;

const AUDIT_SQLITE = `
CREATE TABLE IF NOT EXISTS automation_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  domain TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  detail_json TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const AUDIT_PG = `
CREATE TABLE IF NOT EXISTS automation_audit (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  domain TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  detail_json TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

const STEPS_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_post_acq_domain_status ON post_acquisition_steps(domain, status)';

const AUDIT_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_automation_audit_created_at ON automation_audit(created_at)';

export function up(db: Database.Database): void {
  db.exec(STEPS_SQLITE);
  db.exec(AUDIT_SQLITE);
  db.exec(STEPS_INDEX);
  db.exec(AUDIT_INDEX);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(STEPS_PG);
  await db.exec(AUDIT_PG);
  await db.exec(STEPS_INDEX);
  await db.exec(AUDIT_INDEX);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS automation_audit');
  db.exec('DROP TABLE IF EXISTS post_acquisition_steps');
}
