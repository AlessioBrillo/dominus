// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type {
  Subscription,
  SubscriptionRow,
  SubscriptionPlan,
  SubscriptionStatus,
} from '../../types/subscription.js';
import { subscriptionFromRow } from '../../types/subscription.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

export class SubscriptionRepository {
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  async findByTenantId(tenantId?: string): Promise<Subscription | undefined> {
    const tid = resolveTenantId(tenantId);
    const row = await this.#db.queryOne<SubscriptionRow>(
      'SELECT * FROM tenant_subscriptions WHERE tenant_id = ?',
      [tid],
    );
    return row ? subscriptionFromRow(row) : undefined;
  }

  async findByStripeCustomerId(stripeCustomerId: string): Promise<Subscription | undefined> {
    const row = await this.#db.queryOne<SubscriptionRow>(
      'SELECT * FROM tenant_subscriptions WHERE stripe_customer_id = ?',
      [stripeCustomerId],
    );
    return row ? subscriptionFromRow(row) : undefined;
  }

  async upsert(sub: {
    tenantId: string;
    plan: SubscriptionPlan;
    status: SubscriptionStatus;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    currentPeriodStart?: string | null;
    currentPeriodEnd?: string | null;
    trialEnd?: string | null;
  }): Promise<void> {
    await this.#db.exec(
      `INSERT INTO tenant_subscriptions (tenant_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_start, current_period_end, trial_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET
         plan = excluded.plan,
         status = excluded.status,
         stripe_customer_id = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         trial_end = excluded.trial_end,
         updated_at = datetime('now')`,
      [
        sub.tenantId,
        sub.plan,
        sub.status,
        sub.stripeCustomerId ?? null,
        sub.stripeSubscriptionId ?? null,
        sub.currentPeriodStart ?? null,
        sub.currentPeriodEnd ?? null,
        sub.trialEnd ?? null,
      ],
    );
  }

  async updateStatus(tenantId: string, status: SubscriptionStatus): Promise<void> {
    await this.#db.exec(
      "UPDATE tenant_subscriptions SET status = ?, updated_at = datetime('now') WHERE tenant_id = ?",
      [status, tenantId],
    );
  }

  async updateStripeSubscription(
    tenantId: string,
    stripeSubscriptionId: string,
    status: SubscriptionStatus,
    periodStart: string,
    periodEnd: string,
    plan?: SubscriptionPlan,
  ): Promise<void> {
    await this.#db.exec(
      `UPDATE tenant_subscriptions
       SET stripe_subscription_id = ?, status = ?, current_period_start = ?, current_period_end = ?,
           plan = COALESCE(?, plan), updated_at = datetime('now')
       WHERE tenant_id = ?`,
      [stripeSubscriptionId, status, periodStart, periodEnd, plan ?? null, tenantId],
    );
  }

  async cancel(tenantId: string, canceledAt: string): Promise<void> {
    await this.#db.exec(
      "UPDATE tenant_subscriptions SET status = 'canceled', canceled_at = ?, updated_at = datetime('now') WHERE tenant_id = ?",
      [canceledAt, tenantId],
    );
  }

  async ensureDefault(tenantId: string): Promise<Subscription> {
    const existing = await this.findByTenantId(tenantId);
    if (existing) return existing;

    await this.#db.exec(
      `INSERT INTO tenant_subscriptions (tenant_id, plan, status)
       VALUES (?, 'free', 'active')
       ON CONFLICT(tenant_id) DO NOTHING`,
      [tenantId],
    );

    return (await this.findByTenantId(tenantId))!;
  }
}
