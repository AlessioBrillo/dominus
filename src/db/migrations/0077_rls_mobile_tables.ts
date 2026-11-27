// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0077_rls_mobile_tables';
export const backwardCompatible = true;

/**
 * Extend the strict tenant policy of migration 0070 to the mobile tables.
 *
 * This is a new migration rather than an edit to an already-shipped one:
 * 0070 ran before these tables existed, and editing it would make a fresh
 * apply try to alter tables that do not exist yet. The policy expression is
 * identical — `current_setting('app.tenant_id', true)` is NULL outside a
 * tenant context, so a query without one sees nothing (ADR-0107).
 *
 * `mobile_device_sessions` is deliberately NOT here: like `api_keys` it is
 * read before a tenant context exists (the token establishes the tenant),
 * so a default-deny RLS policy would make the app unable to authenticate.
 */
export const RLS_MOBILE_TABLES = ['push_subscriptions'] as const;

const POLICY = `tenant_id = current_setting('app.tenant_id', true)::TEXT`;

export function up(_db: Database.Database): void {
  // SQLite does not support Row-Level Security.
}

export function down(_db: Database.Database): void {
  // SQLite does not support Row-Level Security: both directions are no-ops.
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  for (const table of RLS_MOBILE_TABLES) {
    await db.exec(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await db.exec(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await db.exec(`DROP POLICY IF EXISTS tenant_isolation_${table} ON ${table}`);
    await db.exec(`CREATE POLICY tenant_isolation_${table} ON ${table} FOR ALL USING (${POLICY})`);
  }
}
