// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type {
  UsageFeature,
  UsageRecord,
  UsageRecordRow,
  PlanLimit,
  PlanLimitRow,
  SubscriptionPlan,
} from '../../types/usage.js';
import { usageRecordFromRow, planLimitFromRow } from '../../types/usage.js';

export class UsageRepository {
  readonly #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  async getUsage(
    tenantId: string,
    feature: UsageFeature,
    periodStart: string,
  ): Promise<UsageRecord | undefined> {
    const row = await this.#db.queryOne<UsageRecordRow>(
      'SELECT * FROM usage_records WHERE tenant_id = ? AND feature = ? AND period_start = ?',
      [tenantId, feature, periodStart],
    );
    return row ? usageRecordFromRow(row) : undefined;
  }

  async incrementUsage(
    tenantId: string,
    feature: UsageFeature,
    amount: number,
    periodStart: string,
  ): Promise<void> {
    await this.#db.exec(
      `INSERT INTO usage_records (tenant_id, feature, amount, period_start)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, feature, period_start) DO UPDATE SET
         amount = amount + excluded.amount,
         recorded_at = datetime('now')`,
      [tenantId, feature, amount, periodStart],
    );
  }

  /**
   * Atomic usage increment guarded by the plan limit.
   *
   * Unlike `incrementUsage` — which is a blind read-then-write pair — this
   * single upsert only applies the increment when the running total stays
   * within `limitValue`. The INSERT guard (`? <= ?` on the SELECT) and the
   * ON CONFLICT guard (`usage_records.amount + excluded.amount <= ?`) are
   * evaluated atomically by the database, so concurrent requests can never
   * overshoot the limit: the sum of every applied increment is always
   * <= limitValue.
   *
   * Returns `true` when the increment was applied, `false` when the limit is
   * already exhausted (or the amount exceeds the allowance outright).
   */
  async incrementUsageIfWithinLimit(
    tenantId: string,
    feature: UsageFeature,
    amount: number,
    periodStart: string,
    limitValue: number | null,
  ): Promise<boolean> {
    if (limitValue === null) {
      await this.incrementUsage(tenantId, feature, amount, periodStart);
      return true;
    }

    const result = await this.#db.exec(
      `INSERT INTO usage_records (tenant_id, feature, amount, period_start)
       SELECT ?, ?, ?, ?
       WHERE ? <= ?
       ON CONFLICT(tenant_id, feature, period_start) DO UPDATE SET
         amount = usage_records.amount + excluded.amount,
         recorded_at = datetime('now')
       WHERE usage_records.amount + excluded.amount <= ?`,
      [tenantId, feature, amount, periodStart, amount, limitValue, limitValue],
    );
    return result.changes > 0;
  }

  /**
   * Decrement a metered unit (floor 0). Used to refund an allowance unit
   * when the operation that consumed it failed transactionally after the
   * meter ran (e.g. a duplicate portfolio/watchlist insert). The guarded
   * upsert only touches rows that already exist, so a refund can never
   * fabricate negative or spurious usage for a tenant that consumed nothing.
   */
  async decrementUsage(
    tenantId: string,
    feature: UsageFeature,
    amount: number,
    periodStart: string,
  ): Promise<void> {
    await this.#db.exec(
      `INSERT INTO usage_records (tenant_id, feature, amount, period_start)
       SELECT ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM usage_records
         WHERE tenant_id = ? AND feature = ? AND period_start = ?
       )
       ON CONFLICT(tenant_id, feature, period_start) DO UPDATE SET
         amount = MAX(0, usage_records.amount - excluded.amount),
         recorded_at = datetime('now')`,
      [tenantId, feature, amount, periodStart, tenantId, feature, periodStart],
    );
  }

  async getUsageForPeriod(
    tenantId: string,
    feature: UsageFeature,
    periodStart: string,
  ): Promise<number> {
    const row = await this.#db.queryOne<{ total: number }>(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM usage_records WHERE tenant_id = ? AND feature = ? AND period_start = ?',
      [tenantId, feature, periodStart],
    );
    return row?.total ?? 0;
  }

  async getPlanLimit(
    plan: SubscriptionPlan,
    feature: UsageFeature,
  ): Promise<PlanLimit | undefined> {
    const row = await this.#db.queryOne<PlanLimitRow>(
      'SELECT * FROM plan_limits WHERE plan = ? AND feature = ?',
      [plan, feature],
    );
    return row ? planLimitFromRow(row) : undefined;
  }

  async getAllPlanLimits(plan: SubscriptionPlan): Promise<PlanLimit[]> {
    const rows = await this.#db.query<PlanLimitRow>('SELECT * FROM plan_limits WHERE plan = ?', [
      plan,
    ]);
    return rows.map(planLimitFromRow);
  }

  async setPlanLimit(
    plan: SubscriptionPlan,
    feature: UsageFeature,
    limitValue: number | null,
  ): Promise<void> {
    await this.#db.exec(
      `INSERT INTO plan_limits (plan, feature, limit_value)
       VALUES (?, ?, ?)
       ON CONFLICT(plan, feature) DO UPDATE SET
         limit_value = excluded.limit_value`,
      [plan, feature, limitValue],
    );
  }

  async deleteUsageOlderThan(cutoff: string): Promise<number> {
    const result = await this.#db.exec('DELETE FROM usage_records WHERE recorded_at < ?', [cutoff]);
    return result.changes;
  }
}
