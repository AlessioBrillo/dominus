// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type { Subscription, SubscriptionRow } from '../../types/subscription.js';
import { subscriptionFromRow } from '../../types/subscription.js';
import type { UsageFeature } from '../../types/usage.js';

export interface AdminUsageRow {
  tenantId: string;
  feature: UsageFeature;
  amount: number;
}

export interface ApiKeyCountRow {
  tenantId: string;
  count: number;
}

export interface TenantActivityRow {
  tenantId: string;
  lastActiveAt: string;
}

/**
 * Cross-tenant read access for the platform admin panel.
 *
 * Scoped strictly to control-plane tables (tenant_subscriptions, api_keys,
 * usage_records, plan_limits) — the same tables the Cloud control plane
 * already reads/writes. Entity tables (candidates, portfolio, ...) are NOT
 * queried here: they are covered by FORCE ROW LEVEL SECURITY on PostgreSQL
 * (migration 0047), so any cross-tenant entity read would be rejected there.
 * The admin surface intentionally stays on non-RLS control-plane data, which
 * keeps the SQL identical on SQLite and PostgreSQL.
 */
export class AdminRepository {
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  /** Every tenant that exists in any control-plane table. */
  async listTenantIds(): Promise<string[]> {
    const rows = await this.#db.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM tenant_subscriptions
       UNION
       SELECT tenant_id FROM api_keys
       UNION
       SELECT tenant_id FROM usage_records`,
    );
    return rows.map((r) => r.tenant_id);
  }

  /** All subscription rows across tenants. */
  async listSubscriptions(): Promise<Subscription[]> {
    const rows = await this.#db.query<SubscriptionRow>(
      'SELECT * FROM tenant_subscriptions ORDER BY tenant_id',
    );
    return rows.map(subscriptionFromRow);
  }

  /** API key counts per tenant (tenants without keys are omitted). */
  async countApiKeysPerTenant(): Promise<ApiKeyCountRow[]> {
    const rows = await this.#db.query<{ tenant_id: string; count: number }>(
      `SELECT tenant_id, COUNT(*) AS count FROM api_keys GROUP BY tenant_id`,
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, count: r.count }));
  }

  /** Usage rows for the given billing period across all tenants/features. */
  async getUsageForPeriod(periodStart: string): Promise<AdminUsageRow[]> {
    const rows = await this.#db.query<{
      tenant_id: string;
      feature: string;
      amount: number;
    }>('SELECT tenant_id, feature, amount FROM usage_records WHERE period_start = ?', [
      periodStart,
    ]);
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      feature: r.feature as UsageFeature,
      amount: r.amount,
    }));
  }

  /**
   * Latest activity per tenant, taken as the most recent of usage records
   * and API key use. ISO string comparison is chronological for both
   * dialects' stored formats.
   */
  async getLastActivity(): Promise<TenantActivityRow[]> {
    const usage = await this.#db.query<{ tenant_id: string; last_active_at: string | null }>(
      `SELECT tenant_id, MAX(recorded_at) AS last_active_at
       FROM usage_records
       GROUP BY tenant_id`,
    );
    const keys = await this.#db.query<{ tenant_id: string; last_used_at: string | null }>(
      `SELECT tenant_id, MAX(last_used_at) AS last_used_at
       FROM api_keys
       WHERE last_used_at IS NOT NULL
       GROUP BY tenant_id`,
    );

    const merged = new Map<string, string>();
    for (const row of usage) {
      if (row.last_active_at) merged.set(row.tenant_id, row.last_active_at);
    }
    for (const row of keys) {
      if (!row.last_used_at) continue;
      const existing = merged.get(row.tenant_id);
      if (!existing || row.last_used_at > existing) {
        merged.set(row.tenant_id, row.last_used_at);
      }
    }

    return [...merged.entries()].map(([tenantId, lastActiveAt]) => ({
      tenantId,
      lastActiveAt,
    }));
  }
}
