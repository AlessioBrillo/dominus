// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0063_create_tenant_automation_settings';
export const backwardCompatible = true;

/**
 * Per-tenant opt-in for the post-acquisition automation pipeline
 * (ADR-0083, Phase 0).
 *
 * One row per tenant, absent until the tenant flips the switch. Defaults
 * are conservative: `enabled = false`, `dry_run = true` — a tenant that
 * never touched the settings is opted out, exactly like the
 * `AUTOMATION_ENABLED` kill switch defaults the whole platform off.
 *
 * Control-plane table, deliberately NOT covered by FORCE ROW LEVEL
 * SECURITY (migration 0047) like `tenant_admin_flags` (migration 0052):
 * there is exactly one row per tenant and every access goes through the
 * repository, which filters on `resolveTenantId()`. The entity tables
 * (`post_acquisition_steps`, `automation_audit`) stay RLS-protected.
 */
const DDL_SQLITE = `
CREATE TABLE IF NOT EXISTS tenant_automation_settings (
  tenant_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  dry_run INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const DDL_PG = `
CREATE TABLE IF NOT EXISTS tenant_automation_settings (
  tenant_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  dry_run INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

export function up(db: Database.Database): void {
  db.exec(DDL_SQLITE);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(DDL_PG);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS tenant_automation_settings');
}
