// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The tables that hold a tenant's data.
 *
 * The registry is the single place that knows which tables are tenant
 * scoped, and it is what the data-subject export and the data-subject
 * deletion walk. Two properties are enforced by a test
 * (src/db/__tests__/tenant-data-registry.test.ts), because a silent omission
 * is the worst kind of bug in this area:
 *
 * 1. **Completeness** — every table in the schema that has a `tenant_id`
 *    column is listed here, and every table listed here exists and has
 *    that column. An omission would make an export incomplete (a GDPR
 *    breach) and leave rows behind after a deletion.
 * 2. **Order** — the list is in deletion order, children before parents.
 *    `scoring_runs.candidate_id` has no ON DELETE action, so the rows that
 *    reference a candidate have to go first; the other foreign keys cascade,
 *    and deleting in this order keeps both dialects happy.
 *
 * The order of the list is the deletion order; the export walks it too, so
 * the export and the deletion always agree on what a tenant owns.
 */
export interface TenantTable {
  /** The table name. */
  readonly table: string;
  /**
   * True when the rows must survive a data-subject deletion because the law
   * requires them to be kept (invoices and the accounting records that
   * follow them). Such rows are exported, and reported as retained in the
   * deletion report, but not deleted.
   */
  readonly retained?: boolean;
}

export const TENANT_SCOPED_TABLES: readonly TenantTable[] = [
  // --- children first: rows that reference another tenant table ---
  { table: 'scoring_runs' },
  { table: 'trademark_results' },
  { table: 'outcome_scores' },
  { table: 'renewal_alerts' },
  { table: 'listing_offers' },
  { table: 'auto_listings' },
  { table: 'pipeline_metrics' },
  { table: 'post_acquisition_steps' },
  { table: 'automation_audit' },

  // --- the tenant's own records ---
  { table: 'candidates' },
  { table: 'outcomes' },
  { table: 'portfolio_entries' },
  { table: 'listings' },
  { table: 'bids' },
  { table: 'watchlist_entries' },
  { table: 'public_scores' },
  { table: 'events' },
  { table: 'onboarding_state' },
  { table: 'pipeline_runs' },
  { table: 'domain_sites' },
  { table: 'funnel_entries' },
  { table: 'monetization_revenue' },

  // --- identity, access and configuration ---
  { table: 'api_keys' },
  { table: 'team_invitations' },
  { table: 'team_seats' },
  { table: 'tenant_admin_flags' },
  { table: 'tenant_automation_settings' },
  { table: 'tenant_credentials' },
  { table: 'tenant_custom_prices' },
  { table: 'tenant_listing_settings' },
  { table: 'usage_records' },

  // --- billing ---
  // The local subscription record is personal data linked to the customer
  // and is deleted with the rest. The invoices themselves live in the
  // payment provider and follow that provider's own retention; the
  // accounting obligation is documented in the privacy notice and in the
  // data processing agreement.
  { table: 'tenant_subscriptions' },
];

/** The table names, in deletion order. */
export const TENANT_TABLE_NAMES: readonly string[] = TENANT_SCOPED_TABLES.map((t) => t.table);

/** The tables whose rows are kept for a legal retention obligation. */
export const RETAINED_TENANT_TABLES: readonly string[] = TENANT_SCOPED_TABLES.filter(
  (t) => t.retained,
).map((t) => t.table);
