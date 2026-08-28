// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0052_create_tenant_admin_flags';
export const backwardCompatible = true;

/**
 * Operator-managed tenant state (ADR-0057): suspension and plan override.
 *
 * Control-plane table — deliberately NOT covered by FORCE ROW LEVEL
 * SECURITY, like tenant_subscriptions/api_keys/usage_records (migration
 * 0047). The admin surface is the only writer; entity tables stay
 * RLS-protected. Identical DDL on SQLite and PostgreSQL.
 */
const DDL = `CREATE TABLE IF NOT EXISTS tenant_admin_flags (
  tenant_id TEXT PRIMARY KEY,
  suspended_at TEXT,
  suspended_reason TEXT,
  plan_override TEXT,
  updated_at TEXT
)`;

export function up(db: Database.Database): void {
  db.exec(DDL);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(DDL);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS tenant_admin_flags');
}
