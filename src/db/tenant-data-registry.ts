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
 *
 * Every entry also declares HOW the table is isolated, because the two
 * mechanisms have very different failure modes:
 *
 * - `rls` — PostgreSQL Row-Level Security enforces the boundary
 *   (migrations 0030/0047/0070). A query that forgets the tenant filter
 *   reads nothing instead of reading another tenant's rows.
 * - `control-plane` — the boundary is the repository: the query always
 *   carries the tenant id. These are the tables that must be read BEFORE a
 *   tenant context exists (auth, billing, the queue) or that are shared by
 *   the platform (the job queue, the operator's own tables).
 *
 * The classification is not a comment: `tenant-data-registry.test.ts`
 * asserts that every table classified as `rls` really has the policy
 * enabled and forced on PostgreSQL, and that no table is classified twice.
 */

/**
 * How a tenant-scoped table is isolated from the other tenants'.
 *
 * - `rls`: PostgreSQL Row-Level Security (FORCE) is the enforcement point.
 * - `control-plane`: the repository always filters by tenant; the table is
 *   read before a tenant context exists, or is shared by the platform.
 */
export type TenantTableIsolation = 'rls' | 'control-plane';

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
  /** How the table is isolated from the other tenants. */
  readonly isolation: TenantTableIsolation;
}

export const TENANT_SCOPED_TABLES: readonly TenantTable[] = [
  // --- children first: rows that reference another tenant table ---
  { table: 'scoring_runs', isolation: 'rls' },
  { table: 'trademark_results', isolation: 'rls' },
  { table: 'outcome_scores', isolation: 'rls' },
  { table: 'renewal_alerts', isolation: 'rls' },
  { table: 'listing_offers', isolation: 'rls' },
  { table: 'auto_listings', isolation: 'rls' },
  { table: 'pipeline_metrics', isolation: 'rls' },
  { table: 'post_acquisition_steps', isolation: 'rls' },
  { table: 'automation_audit', isolation: 'rls' },

  // --- the tenant's own records ---
  { table: 'candidates', isolation: 'rls' },
  { table: 'outcomes', isolation: 'rls' },
  { table: 'portfolio_entries', isolation: 'rls' },
  { table: 'listings', isolation: 'rls' },
  { table: 'bids', isolation: 'rls' },
  { table: 'watchlist_entries', isolation: 'rls' },
  { table: 'public_scores', isolation: 'rls' },
  { table: 'events', isolation: 'rls' },
  { table: 'onboarding_state', isolation: 'rls' },
  { table: 'pipeline_runs', isolation: 'rls' },
  { table: 'domain_sites', isolation: 'rls' },
  { table: 'funnel_entries', isolation: 'rls' },
  { table: 'monetization_revenue', isolation: 'rls' },

  // --- the work the tenant asked for, still queued ---
  // The queue is global (a worker drains every tenant), but the row belongs
  // to the tenant that asked for it: its payload carries the domains, so it
  // must not survive the erasure of the account (ADR-0018, art. 17).
  { table: 'job_queue', isolation: 'control-plane' },
  { table: 'dead_letter_jobs', isolation: 'control-plane' },

  // --- identity, access and configuration ---
  { table: 'api_keys', isolation: 'control-plane' },
  { table: 'team_invitations', isolation: 'control-plane' },
  { table: 'team_seats', isolation: 'control-plane' },
  { table: 'signup_verifications', isolation: 'control-plane' },
  { table: 'tenant_admin_flags', isolation: 'control-plane' },
  { table: 'tenant_automation_settings', isolation: 'control-plane' },
  { table: 'tenant_credentials', isolation: 'control-plane' },
  { table: 'tenant_custom_prices', isolation: 'control-plane' },
  { table: 'tenant_listing_settings', isolation: 'control-plane' },
  { table: 'tenant_notification_settings', isolation: 'control-plane' },
  { table: 'usage_records', isolation: 'control-plane' },

  // --- billing ---
  // The local subscription record is personal data linked to the customer
  // and is deleted with the rest. The invoices themselves live in the
  // payment provider and follow that provider's own retention; the
  // accounting obligation is documented in the privacy notice and in the
  // data processing agreement.
  { table: 'tenant_subscriptions', isolation: 'control-plane' },
];

/** The table names, in deletion order. */
export const TENANT_TABLE_NAMES: readonly string[] = TENANT_SCOPED_TABLES.map((t) => t.table);

/** The tables whose rows are kept for a legal retention obligation. */
export const RETAINED_TENANT_TABLES: readonly string[] = TENANT_SCOPED_TABLES.filter(
  (t) => t.retained,
).map((t) => t.table);

/** The tables whose boundary is enforced by PostgreSQL Row-Level Security. */
export const RLS_PROTECTED_TABLES: readonly string[] = TENANT_SCOPED_TABLES.filter(
  (t) => t.isolation === 'rls',
).map((t) => t.table);

/** The tables whose boundary is enforced by the repository (control plane). */
export const CONTROL_PLANE_TABLES: readonly string[] = TENANT_SCOPED_TABLES.filter(
  (t) => t.isolation === 'control-plane',
).map((t) => t.table);
