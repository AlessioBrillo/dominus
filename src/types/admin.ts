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
  usage: AdminTenantUsage[];
}
