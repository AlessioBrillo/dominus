// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';

export type UsagePlan = 'free' | 'pro' | 'team' | 'enterprise';
export type UsageFeature = 'candidates_scored' | 'api_calls' | 'domains_tracked';

export interface UsageForPeriod {
  feature: UsageFeature;
  currentUsage: number;
  limitValue: number | null;
  remaining: number | null;
  isOverLimit: boolean;
  plan: UsagePlan;
  periodStart: string;
  periodEnd: string;
}

export interface UsageHistoryEntry {
  periodStart: string;
  periodEnd: string;
  plan: UsagePlan;
  usage: Record<UsageFeature, UsageForPeriod>;
}

export function fetchUsageHistory(months = 6): Promise<UsageHistoryEntry[]> {
  return api.get<UsageHistoryEntry[]>(`/usage/history?months=${months}`);
}
