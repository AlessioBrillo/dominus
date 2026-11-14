// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0070_close_the_rls_default';
export const backwardCompatible = true;

/**
 * Row-Level Security that denies instead of defaulting.
 *
 * Two gaps are closed here.
 *
 * 1. **Seven tenant tables had no policy at all.** The registry
 *    (src/db/tenant-data-registry.ts) knows 32 tenant-scoped tables; the
 *    policies of migration 0030 covered 15. The other 17 (now 22 with the
 *    control-plane ones) relied on the repository filter alone: a single
 *    forgotten `WHERE tenant_id = ?` was a cross-tenant read with no
 *    database-layer backstop.
 *
 * 2. **The policy defaulted to the 'default' tenant.** `COALESCE(
 *    current_setting('app.tenant_id', true), 'default')` meant that a query
 *    made outside a tenant context did not fail: it read (and wrote) the
 *    rows of a tenant that belongs to nobody. A missing context was
 *    invisible. The policy now denies: with no `app.tenant_id`, the row is
 *    not visible, and an INSERT that does not belong to the current tenant
 *    raises a policy violation instead of landing somewhere else.
 *
 * The `public_scores` table keeps its public read: the anonymous SEO
 * surface reads it with the 'public' tenant.
 */
const TABLES_WITH_STRICT_POLICY = [
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
  'public_scores',
] as const;

/** The tenant tables that had no policy at all until now. */
const NEWLY_PROTECTED_TABLES = [
  'pipeline_runs',
  'pipeline_metrics',
  'post_acquisition_steps',
  'automation_audit',
  'domain_sites',
  'funnel_entries',
  'monetization_revenue',
] as const;

/** Every table the policies of this migration cover. */
export const RLS_STRICT_TABLES: readonly string[] = [
  ...TABLES_WITH_STRICT_POLICY,
  ...NEWLY_PROTECTED_TABLES,
];

/**
 * The policy of a tenant table.
 *
 * `current_setting('app.tenant_id', true)` is NULL when no tenant context
 * is active: `tenant_id = NULL` is never true, so the row is invisible.
 * That is the point — a query without a context must fail closed.
 */
function policyFor(table: string): string {
  const extra =
    table === 'public_scores' ? " OR (current_setting('app.tenant_id', true) = 'public')" : '';
  return `tenant_id = current_setting('app.tenant_id', true)::TEXT${extra}`;
}

export function up(_db: Database.Database): void {
  // SQLite does not support Row-Level Security.
}

export function down(_db: Database.Database): void {
  // SQLite does not support Row-Level Security: the up() is a no-op here,
  // and so is the down().
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  for (const table of RLS_STRICT_TABLES) {
    await db.exec(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await db.exec(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await db.exec(`DROP POLICY IF EXISTS tenant_isolation_${table} ON ${table}`);
    await db.exec(
      `CREATE POLICY tenant_isolation_${table} ON ${table} FOR ALL USING (${policyFor(table)})`,
    );
  }
}
