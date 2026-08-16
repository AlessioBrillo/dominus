// SPDX-License-Identifier: AGPL-3.0-only
import type { UsageRepository } from '../db/repositories/usage-repository.js';
import type { SubscriptionRepository } from '../db/repositories/subscription-repository.js';
import type { UsageFeature, UsageForPeriod, UsageHistoryEntry, PlanLimit } from '../types/usage.js';
import type { Subscription, SubscriptionPlan } from '../types/subscription.js';
import { USAGE_FEATURES } from '../types/usage.js';
import { UsageLimitExceededError } from '../types/errors.js';
import { effectivePlanFor, ACTIVE_PLAN_STATUSES } from './effective-plan.js';

export { effectivePlanFor, ACTIVE_PLAN_STATUSES };

export interface UsageMeterServiceOptions {
  /**
   * When true, record() auto-provisions a free-plan subscription for a
   * tenant that has none (SubscriptionRepository.ensureDefault is already
   * idempotent) instead of throwing. Enabled for the managed Cloud via
   * AUTO_PROVISION_TENANTS; the community edition keeps `record()` strict.
   */
  autoProvisionTenants?: boolean;
  /**
   * Operator plan override lookup (ADR-0057). When the provider returns a
   * non-null plan, it wins over the subscription-derived effective plan —
   * a deliberate manual grant (enterprise trials, SLA compensation) that
   * must survive subscription status changes. Absent, enforcement stays
   * purely subscription-driven.
   */
  planOverrideProvider?: (tenantId: string) => Promise<SubscriptionPlan | null>;
}

export class UsageMeterService {
  readonly #usageRepo: UsageRepository;
  readonly #subRepo: SubscriptionRepository;
  readonly #autoProvisionTenants: boolean;
  readonly #planOverrideProvider:
    ((tenantId: string) => Promise<SubscriptionPlan | null>) | undefined;

  constructor(
    usageRepo: UsageRepository,
    subRepo: SubscriptionRepository,
    options: UsageMeterServiceOptions = {},
  ) {
    this.#usageRepo = usageRepo;
    this.#subRepo = subRepo;
    this.#autoProvisionTenants = options.autoProvisionTenants ?? false;
    this.#planOverrideProvider = options.planOverrideProvider;
  }

  /** Effective plan for a tenant: operator override first, then subscription. */
  async #resolvePlan(
    tenantId: string,
    sub: Subscription | null | undefined,
  ): Promise<SubscriptionPlan> {
    const override = this.#planOverrideProvider ? await this.#planOverrideProvider(tenantId) : null;
    return effectivePlanFor(sub, override);
  }

  static periodStart(dateStr: string): string {
    const d = new Date(dateStr);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  }

  /** Effective plan for a tenant, shared by every plan-dependent consumer
   *  (usage metering, seat limits at key mint). Operator override wins. */
  async effectivePlan(tenantId: string): Promise<SubscriptionPlan> {
    const sub = await this.#subRepo.findByTenantId(tenantId);
    return this.#resolvePlan(tenantId, sub);
  }

  async record(
    tenantId: string,
    feature: UsageFeature,
    amount: number,
    periodStart: string,
  ): Promise<UsageForPeriod> {
    let sub = await this.#subRepo.findByTenantId(tenantId);
    if (!sub && this.#autoProvisionTenants) {
      sub = await this.#subRepo.ensureDefault(tenantId);
    }
    if (!sub) {
      throw new Error(`No active subscription for tenant ${tenantId}`);
    }

    const plan = await this.#resolvePlan(tenantId, sub);
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

  /**
   * Refund a metered unit (floor 0) after a transactional failure. Callers
   * must only invoke this for units they actually consumed — the repository
   * guard makes spurious refunds a no-op (ADR-0038, failure policy).
   */
  async refund(
    tenantId: string,
    feature: UsageFeature,
    amount: number,
    periodStart: string,
  ): Promise<void> {
    await this.#usageRepo.decrementUsage(tenantId, feature, amount, periodStart);
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
    const plan = await this.#resolvePlan(tenantId, sub);

    const limit = await this.#usageRepo.getPlanLimit(plan, feature);
    const limitValue = limit?.limitValue ?? null;

    const currentUsage = await this.#usageRepo.getUsageForPeriod(tenantId, feature, periodStart);

    const periodEnd = this.#periodEnd(periodStart);

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
    const plan = await this.#resolvePlan(tenantId, sub);
    return this.#usageRepo.getAllPlanLimits(plan);
  }

  /**
   * Per-month usage history for a tenant, oldest month first. Limits are
   * resolved once against the tenant's current effective plan, so a
   * past-due subscription shows free-plan limits across the whole window
   * (same fail-closed rule as `getUsageForPeriod`).
   */
  async getUsageHistory(tenantId: string, months = 6): Promise<UsageHistoryEntry[]> {
    const sub = await this.#subRepo.findByTenantId(tenantId);
    const plan = await this.#resolvePlan(tenantId, sub);

    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
    const from = UsageMeterService.periodStart(first.toISOString());
    const to = UsageMeterService.periodStart(now.toISOString());

    const records = await this.#usageRepo.findUsageByPeriodRange(tenantId, from, to);
    const sums = new Map<string, Partial<Record<UsageFeature, number>>>();
    for (const record of records) {
      const entry = sums.get(record.periodStart) ?? {};
      entry[record.feature] = (entry[record.feature] ?? 0) + record.amount;
      sums.set(record.periodStart, entry);
    }

    const limits = await this.#usageRepo.getAllPlanLimits(plan);
    const limitByFeature = new Map(limits.map((l) => [l.feature, l.limitValue]));

    const history: UsageHistoryEntry[] = [];
    for (let offset = months - 1; offset >= 0; offset--) {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
      const periodStart = UsageMeterService.periodStart(month.toISOString());
      const periodEnd = this.#periodEnd(periodStart);
      const periodSums = sums.get(periodStart) ?? {};

      const usage = {} as Record<UsageFeature, UsageForPeriod>;
      for (const feature of USAGE_FEATURES) {
        const limitValue = limitByFeature.get(feature) ?? null;
        const currentUsage = periodSums[feature] ?? 0;
        usage[feature] = {
          feature,
          currentUsage,
          limitValue,
          remaining: limitValue !== null ? Math.max(0, limitValue - currentUsage) : null,
          isOverLimit: limitValue !== null ? currentUsage >= limitValue : false,
          plan,
          periodStart,
          periodEnd,
        };
      }

      history.push({ periodStart, periodEnd, plan, usage });
    }
    return history;
  }

  #periodEnd(periodStart: string): string {
    const year = periodStart.slice(0, 4);
    const month = periodStart.slice(5, 7);
    const daysInMonth = new Date(Number(year), Number(month), 0).getDate();
    return `${year}-${month}-${String(daysInMonth).padStart(2, '0')}`;
  }
}
