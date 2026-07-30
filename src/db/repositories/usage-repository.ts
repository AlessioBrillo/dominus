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
