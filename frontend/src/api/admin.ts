// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';

export type AdminPlan = 'free' | 'pro' | 'team' | 'enterprise';
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
  suspended: boolean;
  usage: AdminTenantUsage[];
}

export interface TenantAdminFlag {
  tenantId: string;
  suspendedAt: string | null;
  suspendedReason: string | null;
  planOverride: AdminPlan | null;
  updatedAt: string | null;
}

export interface AdminUsageSeriesPoint {
  date: string;
  feature: AdminFeature;
  amount: number;
}

export function fetchAdminOverview(): Promise<AdminOverview> {
  return api.get<AdminOverview>('/admin/overview');
}

export function fetchAdminTenants(): Promise<AdminTenantSummary[]> {
  return api.get<AdminTenantSummary[]>('/admin/tenants');
}

export function fetchAdminTenantUsage(
  tenantId: string,
  days: number,
  signal?: AbortSignal,
): Promise<AdminUsageSeriesPoint[]> {
  return api.get<AdminUsageSeriesPoint[]>(
    `/admin/tenants/${encodeURIComponent(tenantId)}/usage?days=${days}`,
    signal,
  );
}

export function suspendTenant(tenantId: string, reason: string | null): Promise<TenantAdminFlag> {
  return api.post<TenantAdminFlag>(`/admin/tenants/${encodeURIComponent(tenantId)}/suspend`, {
    reason: reason ?? undefined,
  });
}

export function unsuspendTenant(tenantId: string): Promise<TenantAdminFlag> {
  return api.post<TenantAdminFlag>(`/admin/tenants/${encodeURIComponent(tenantId)}/unsuspend`);
}

export function setPlanOverride(
  tenantId: string,
  plan: AdminPlan | null,
): Promise<TenantAdminFlag> {
  return api.post<TenantAdminFlag>(`/admin/tenants/${encodeURIComponent(tenantId)}/plan-override`, {
    plan,
  });
}
