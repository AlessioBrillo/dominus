// SPDX-License-Identifier: AGPL-3.0-only
import type { UsageRepository } from '../db/repositories/usage-repository.js';
import type { SubscriptionRepository } from '../db/repositories/subscription-repository.js';
import type { UsageFeature, UsageForPeriod, PlanLimit, SubscriptionPlan } from '../types/usage.js';
import { UsageLimitExceededError } from '../types/errors.js';

export class UsageMeterService {
  readonly #usageRepo: UsageRepository;
  readonly #subRepo: SubscriptionRepository;

  constructor(usageRepo: UsageRepository, subRepo: SubscriptionRepository) {
    this.#usageRepo = usageRepo;
    this.#subRepo = subRepo;
  }

  static periodStart(dateStr: string): string {
    const d = new Date(dateStr);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  async record(
    tenantId: string,
    feature: UsageFeature,
    amount: number,
    periodStart: string,
  ): Promise<UsageForPeriod> {
    const sub = await this.#subRepo.findByTenantId(tenantId);
    const plan: SubscriptionPlan = sub?.plan ?? 'free';

    const limit = await this.#usageRepo.getPlanLimit(plan, feature);
    const limitValue = limit?.limitValue ?? null;

    // Atomic check-and-increment: the repository applies the increment in a
    // single guarded statement, so concurrent requests cannot overshoot the
    // limit (no TOCTOU race between read and write).
    const applied = await this.#usageRepo.incrementUsageIfWithinLimit(
      tenantId,
      feature,
      amount,
      periodStart,
      limitValue,
    );
    if (!applied) {
      const current = await this.#usageRepo.getUsageForPeriod(tenantId, feature, periodStart);
      throw new UsageLimitExceededError(feature, current, amount, limitValue);
    }

    return this.getUsageForPeriod(tenantId, feature, periodStart);
  }

  async check(
    tenantId: string,
    feature: UsageFeature,
    periodStart: string,
  ): Promise<UsageForPeriod> {
    return this.getUsageForPeriod(tenantId, feature, periodStart);
  }

  async getUsageForPeriod(
    tenantId: string,
    feature: UsageFeature,
    periodStart: string,
  ): Promise<UsageForPeriod> {
    const sub = await this.#subRepo.findByTenantId(tenantId);
    const plan: SubscriptionPlan = sub?.plan ?? 'free';

    const limit = await this.#usageRepo.getPlanLimit(plan, feature);
    const limitValue = limit?.limitValue ?? null;

    const currentUsage = await this.#usageRepo.getUsageForPeriod(tenantId, feature, periodStart);

    const year = periodStart.slice(0, 4);
    const month = periodStart.slice(5, 7);
    const daysInMonth = new Date(Number(year), Number(month), 0).getDate();
    const periodEnd = `${year}-${month}-${String(daysInMonth).padStart(2, '0')}`;

    const remaining = limitValue !== null ? Math.max(0, limitValue - currentUsage) : null;
    const isOverLimit = limitValue !== null ? currentUsage >= limitValue : false;

    return {
      feature,
      currentUsage,
      limitValue,
      remaining,
      isOverLimit,
      plan,
      periodStart,
      periodEnd,
    };
  }

  async getAllPlanLimitsForTenant(tenantId: string): Promise<PlanLimit[]> {
    const sub = await this.#subRepo.findByTenantId(tenantId);
    const plan: SubscriptionPlan = sub?.plan ?? 'free';
    return this.#usageRepo.getAllPlanLimits(plan);
  }
}
