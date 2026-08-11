// SPDX-License-Identifier: AGPL-3.0-only
import type { AdminRepository } from '../db/repositories/admin-repository.js';
import type { UsageRepository } from '../db/repositories/usage-repository.js';
import type { AdminOverview, AdminTenantSummary, AdminTenantUsage } from '../types/admin.js';
import type { UsageFeature } from '../types/usage.js';
import type { Subscription, SubscriptionPlan, SubscriptionStatus } from '../types/subscription.js';

const FEATURES: UsageFeature[] = ['candidates_scored', 'api_calls', 'domains_tracked'];

/** Last day of the month for a `YYYY-MM-01` period start. */
export function periodEnd(periodStart: string): string {
  const [year, month] = periodStart.split('-').map(Number);
  // Day 0 of the following month == last day of the current month.
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`;
}

/**
 * Platform-level admin read model (DOMINUS Cloud operator panel).
 *
 * Aggregates control-plane data only — tenant subscriptions, API key
 * counts and metered usage — for every tenant in the system. See
 * AdminRepository for why the surface excludes entity tables (RLS on PG).
 */
export class AdminService {
  readonly #adminRepo: AdminRepository;
  readonly #usageRepo: UsageRepository;

  constructor(adminRepo: AdminRepository, usageRepo: UsageRepository) {
    this.#adminRepo = adminRepo;
    this.#usageRepo = usageRepo;
  }

  async overview(periodStart: string): Promise<AdminOverview> {
    const [subs, usageRows, tenantIds] = await Promise.all([
      this.#adminRepo.listSubscriptions(),
      this.#adminRepo.getUsageForPeriod(periodStart),
      this.#adminRepo.listTenantIds(),
    ]);

    let candidatesScoredTotal = 0;
    let apiCallsTotal = 0;
    for (const row of usageRows) {
      if (row.feature === 'candidates_scored') candidatesScoredTotal += row.amount;
      else if (row.feature === 'api_calls') apiCallsTotal += row.amount;
    }

    const activeSubscriptions = subs.filter((s) => s.status === 'active').length;
    const paidPlans = subs.filter((s) => s.plan !== 'free' && s.status === 'active').length;

    return {
      periodStart,
      periodEnd: periodEnd(periodStart),
      tenantsCount: tenantIds.length,
      activeSubscriptions,
      paidPlans,
      candidatesScoredTotal,
      apiCallsTotal,
    };
  }

  async listTenants(periodStart: string): Promise<AdminTenantSummary[]> {
    const [tenantIds, subs, keyCounts, usageRows, activity] = await Promise.all([
      this.#adminRepo.listTenantIds(),
      this.#adminRepo.listSubscriptions(),
      this.#adminRepo.countApiKeysPerTenant(),
      this.#adminRepo.getUsageForPeriod(periodStart),
      this.#adminRepo.getLastActivity(),
    ]);

    const subByTenant = new Map<string, Subscription>(subs.map((s) => [s.tenantId, s]));
    const keyCountByTenant = new Map<string, number>(keyCounts.map((k) => [k.tenantId, k.count]));
    const activityByTenant = new Map<string, string>(
      activity.map((a) => [a.tenantId, a.lastActiveAt]),
    );

    // Usage rows are per (tenant, feature, period); merge features per tenant.
    const usageByTenant = new Map<string, Map<UsageFeature, number>>();
    for (const row of usageRows) {
      const perFeature = usageByTenant.get(row.tenantId) ?? new Map();
      perFeature.set(row.feature, (perFeature.get(row.feature) ?? 0) + row.amount);
      usageByTenant.set(row.tenantId, perFeature);
    }

    const summaries: AdminTenantSummary[] = [];
    for (const tenantId of tenantIds.sort()) {
      const sub = subByTenant.get(tenantId);
      const plan: SubscriptionPlan = sub?.plan ?? 'free';
      const status: SubscriptionStatus = sub?.status ?? 'active';

      const planLimits = await this.#usageRepo.getAllPlanLimits(plan);
      const limitByFeature = new Map<UsageFeature, number | null>(
        planLimits.map((l) => [l.feature, l.limitValue]),
      );

      const usage: AdminTenantUsage[] = FEATURES.map((feature) => ({
        feature,
        used: usageByTenant.get(tenantId)?.get(feature) ?? 0,
        limit: limitByFeature.get(feature) ?? null,
      }));

      summaries.push({
        tenantId,
        plan,
        status,
        apiKeyCount: keyCountByTenant.get(tenantId) ?? 0,
        lastActiveAt: activityByTenant.get(tenantId) ?? null,
        usage,
      });
    }

    return summaries;
  }
}
