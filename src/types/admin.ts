// SPDX-License-Identifier: AGPL-3.0-only
import type { SubscriptionPlan, SubscriptionStatus } from './subscription.js';
import type { UsageFeature } from './usage.js';

export interface AdminOverview {
  periodStart: string;
  periodEnd: string;
  tenantsCount: number;
  activeSubscriptions: number;
  /** Subscriptions on a paid plan (pro/enterprise). */
  paidPlans: number;
  candidatesScoredTotal: number;
  apiCallsTotal: number;
}

export interface AdminTenantUsage {
  feature: UsageFeature;
  used: number;
  limit: number | null;
}

export interface AdminTenantSummary {
  tenantId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  apiKeyCount: number;
  lastActiveAt: string | null;
  /** Whether the operator currently suspends this tenant (ADR-0057). */
  suspended: boolean;
  usage: AdminTenantUsage[];
}

/**
 * Operator-managed tenant state (ADR-0057). A row exists only once an
 * operator suspends a tenant or grants a plan override; absence means
 * "not suspended, no override" — the safe default.
 */
export interface TenantAdminFlag {
  tenantId: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  planOverride: SubscriptionPlan | null;
  updatedAt: string | null;
}

export interface AdminTenantDetail extends AdminTenantSummary {
  flags: TenantAdminFlag | null;
}

export interface AdminUsageSeriesPoint {
  /** Day key in `YYYY-MM-DD` (UTC). */
  date: string;
  feature: UsageFeature;
  amount: number;
}

export interface AdminSuspendRequest {
  reason?: string;
}

export interface AdminPlanOverrideRequest {
  /** 'free' | 'pro' | 'team' | 'enterprise', or null to clear. */
  plan: SubscriptionPlan | null;
}
