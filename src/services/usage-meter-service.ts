// SPDX-License-Identifier: AGPL-3.0-only
import type { UsageRepository } from '../db/repositories/usage-repository.js';
import type { SubscriptionRepository } from '../db/repositories/subscription-repository.js';
import type { Subscription, SubscriptionStatus } from '../types/subscription.js';
import type { UsageFeature, UsageForPeriod, PlanLimit, SubscriptionPlan } from '../types/usage.js';
import { UsageLimitExceededError } from '../types/errors.js';

/**
 * Subscription statuses that still grant the paid plan's limits. Anything
 * else (past_due, canceled, incomplete, ...) fails closed to the free plan:
 * a tenant whose billing lapses must not keep paid capacity. The webhook
 * writes the Stripe status into tenant_subscriptions, so enforcement tracks
 * reality without waiting for subscription.deleted (ADR-0053).
 */
const ACTIVE_PLAN_STATUSES: ReadonlySet<SubscriptionStatus> = new Set(['active', 'trialing']);

/**
 * Effective plan for enforcement, derived from the subscription row.
 * Null or non-current statuses always resolve to 'free' — the fail-closed
 * choice: it is better to temporarily under-serve a paying tenant whose
 * card bounced than to hand paid capacity to one whose billing lapsed.
 */
export function effectivePlanFor(sub: Subscription | null | undefined): SubscriptionPlan {
  if (sub !== null && sub !== undefined && ACTIVE_PLAN_STATUSES.has(sub.status)) {
    return sub.plan;
  }
  return 'free';
}

export interface UsageMeterServiceOptions {
  /**
   * When true, record() auto-provisions a free-plan subscription for a
   * tenant that has none (SubscriptionRepository.ensureDefault is already
   * idempotent) instead of throwing. Enabled for the managed Cloud via
   * AUTO_PROVISION_TENANTS; the community edition keeps `record()` strict.
   */
  autoProvisionTenants?: boolean;
}

export class UsageMeterService {
  readonly #usageRepo: UsageRepository;
  readonly #subRepo: SubscriptionRepository;
  readonly #autoProvisionTenants: boolean;

  constructor(
    usageRepo: UsageRepository,
    subRepo: SubscriptionRepository,
    options: UsageMeterServiceOptions = {},
  ) {
    this.#usageRepo = usageRepo;
    this.#subRepo = subRepo;
    this.#autoProvisionTenants = options.autoProvisionTenants ?? false;
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
    let sub = await this.#subRepo.findByTenantId(tenantId);
    if (!sub && this.#autoProvisionTenants) {
      sub = await this.#subRepo.ensureDefault(tenantId);
    }
    if (!sub) {
      throw new Error(`No active subscription for tenant ${tenantId}`);
    }

    const plan = effectivePlanFor(sub);
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
    const plan = effectivePlanFor(sub);

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
    const plan = effectivePlanFor(sub);
    return this.#usageRepo.getAllPlanLimits(plan);
  }
}
