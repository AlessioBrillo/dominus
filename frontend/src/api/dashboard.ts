// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';
import { fetchPortfolioEntries } from './portfolio.js';
import type { Alert, HealthResponse, PortfolioEntry } from '../types/domain.js';

export interface DashboardStats {
  totalDomains: number;
  keepCount: number;
  dropCount: number;
  repriceCount: number;
  totalListValue: number;
  activeAlertCount: number;
  recentAlerts: Alert[];
  health: HealthResponse | null;
}

export interface DashboardResult {
  stats: DashboardStats;
  partialFailure: boolean;
  failureReasons: string[];
}

export async function fetchDashboardStats(signal?: AbortSignal): Promise<DashboardResult> {
  const failures: string[] = [];

  const [health, portfolioEntries, alertsData] = await Promise.allSettled([
    api.get<HealthResponse>('/health', signal),
    fetchPortfolioEntries(signal),
    api.get<{ alerts: Alert[] }>('/alerts', signal),
  ]);

  const healthVal =
    health.status === 'fulfilled'
      ? health.value
      : (() => {
          failures.push('health');
          return null;
        })();
  const portfolioVal =
    portfolioEntries.status === 'fulfilled'
      ? portfolioEntries.value
      : (() => {
          failures.push('portfolio');
          return [] as PortfolioEntry[];
        })();
  const alertsVal =
    alertsData.status === 'fulfilled'
      ? alertsData.value
      : (() => {
          failures.push('alerts');
          return { alerts: [] as Alert[] };
        })();

  const portfolio = portfolioVal;
  const alerts = alertsVal.alerts;

  return {
    stats: {
      totalDomains: portfolio.length,
      keepCount: portfolio.filter((p) => p.verdict === 'keep').length,
      dropCount: portfolio.filter((p) => p.verdict === 'drop').length,
      repriceCount: portfolio.filter((p) => p.verdict === 'reprice' || p.verdict === 'hold').length,
      totalListValue: portfolio.reduce((sum, p) => sum + (p.suggestedListPrice ?? 0), 0),
      activeAlertCount: alerts.filter((a) => !a.acknowledgedAt).length,
      recentAlerts: alerts.filter((a) => !a.acknowledgedAt).slice(0, 5),
      health: healthVal,
    },
    partialFailure: failures.length > 0,
    failureReasons: failures,
  };
}
