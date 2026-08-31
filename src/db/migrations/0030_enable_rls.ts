// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0030_enable_rls';
export const backwardCompatible = true;

export function up(_db: Database.Database): void {
  // SQLite does not support Row-Level Security.
  // RLS is PG-only — see upPg below.
}

export function down(_db: Database.Database): void {
  // No-op
}

const ENTITY_TABLES = [
  'candidates',
  'scoring_runs',
  'portfolio_entries',
  'trademark_results',
  'outcomes',
  'outcome_scores',
  'watchlist_entries',
  'listings',
  'listing_offers',
  'bids',
  'renewal_alerts',
  'auto_listings',
  'events',
  'onboarding_state',
  { name: 'public_scores', extraUsing: "OR current_setting('app.tenant_id', true) = 'public'" },
] as const;

export async function upPg(db: DatabaseProvider): Promise<void> {
  // Create a safe helper function for getting the current tenant_id.
  // current_setting(setting, missing_ok) returns NULL if missing_ok=true and setting unset.
  // COALESCE provides a default. Wrapped in a function to avoid syntax issues in policies.
  await db.exec(`
    CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER AS $$
      SELECT COALESCE(current_setting('app.tenant_id', true), 'default');
    $$;
  `);

  for (const table of ENTITY_TABLES) {
    const tableName = typeof table === 'string' ? table : table.name;
    const extraUsing = typeof table === 'string' ? '' : table.extraUsing;

    await db.exec(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
    await db.exec(`DROP POLICY IF EXISTS tenant_isolation_${tableName} ON ${tableName}`);

    // Use the helper function for safe tenant_id resolution.
    // The extraUsing for public_scores adds an OR clause for public access.
    const usingClause = `tenant_id = current_tenant_id()::TEXT${extraUsing ?? ''}`;
    await db.exec(
      `CREATE POLICY tenant_isolation_${tableName} ON ${tableName} FOR ALL USING (${usingClause})`,
    );
  }
}
