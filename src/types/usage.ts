// SPDX-License-Identifier: AGPL-3.0-only
import type { SubscriptionPlan } from './subscription.js';

export type { SubscriptionPlan };

export type UsageFeature = 'candidates_scored' | 'api_calls' | 'domains_tracked';

export const USAGE_FEATURES = ['candidates_scored', 'api_calls', 'domains_tracked'] as const;

export function isUsageFeature(value: string): value is UsageFeature {
  return (USAGE_FEATURES as readonly string[]).includes(value);
}

export interface UsageRecord {
  id: number;
  tenantId: string;
  feature: UsageFeature;
  amount: number;
  periodStart: string;
  recordedAt: string;
}

export interface UsageRecordRow {
  id: number;
  tenant_id: string;
  feature: string;
  amount: number;
  period_start: string;
  recorded_at: string;
}

export function usageRecordFromRow(row: UsageRecordRow): UsageRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    feature: row.feature as UsageFeature,
    amount: row.amount,
    periodStart: row.period_start,
    recordedAt: row.recorded_at,
  };
}

export interface PlanLimit {
  plan: SubscriptionPlan;
  feature: UsageFeature;
  limitValue: number | null;
}

export interface PlanLimitRow {
  plan: string;
  feature: string;
  limit_value: number | null;
}

export function planLimitFromRow(row: PlanLimitRow): PlanLimit {
  return {
    plan: row.plan as SubscriptionPlan,
    feature: row.feature as UsageFeature,
    limitValue: row.limit_value,
  };
}

export interface UsageForPeriod {
  feature: UsageFeature;
  currentUsage: number;
  limitValue: number | null;
  remaining: number | null;
  isOverLimit: boolean;
  plan: SubscriptionPlan;
  periodStart: string;
  periodEnd: string;
}

export interface PlanLimitsMap {
  [feature: string]: number | null;
}

export interface UsageHistoryEntry {
  periodStart: string;
  periodEnd: string;
  plan: SubscriptionPlan;
  usage: Record<UsageFeature, UsageForPeriod>;
}
