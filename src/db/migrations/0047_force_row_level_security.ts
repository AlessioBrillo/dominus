// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0047_force_row_level_security';

// Tables that carry a tenant_id column (ADR-0034) and are protected by the
// tenant_isolation_* policy created in 0030_enable_rls.
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
  'public_scores',
] as const;

export function up(_db: Database.Database): void {
  // SQLite has no row-level security; this is a PG-only hardening.
}

export function down(_db: Database.Database): void {
  // No-op
}

/**
 * FORCE ROW LEVEL SECURITY makes the tenant_isolation_* policy binding on the
 * table owner, not just non-owner roles (PG applies RLS to the owner only
 * when FORCE is set). Without this, the multi-tenant guarantee rests solely
 * on repository-level tenant_id filters, and any missed filter in new code
 * becomes a cross-tenant read.
 *
 * Superusers still bypass RLS: production must run the app as the dedicated
 * non-superuser role provisioned in deploy/init-app-role.sql. See
 * docs/adr/0038-tenant-isolation.md.
 */
export async function upPg(db: DatabaseProvider): Promise<void> {
  for (const table of ENTITY_TABLES) {
    await db.exec(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  }
}
