// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';

export type AdminPlan = 'free' | 'pro' | 'enterprise';
export type AdminStatus = 'active' | 'past_due' | 'canceled' | 'incomplete' | 'trialing';
export type AdminFeature = 'candidates_scored' | 'api_calls' | 'domains_tracked';

export interface AdminOverview {
  periodStart: string;
  periodEnd: string;
  tenantsCount: number;
  activeSubscriptions: number;
  paidPlans: number;
  candidatesScoredTotal: number;
  apiCallsTotal: number;
}

export interface AdminTenantUsage {
  feature: AdminFeature;
  used: number;
  limit: number | null;
}

export interface AdminTenantSummary {
  tenantId: string;
  plan: AdminPlan;
  status: AdminStatus;
  apiKeyCount: number;
  lastActiveAt: string | null;
  usage: AdminTenantUsage[];
}

export function fetchAdminOverview(): Promise<AdminOverview> {
  return api.get<AdminOverview>('/admin/overview');
}

export function fetchAdminTenants(): Promise<AdminTenantSummary[]> {
  return api.get<AdminTenantSummary[]>('/admin/tenants');
}
