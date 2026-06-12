import { api } from './client.js';
import type { Alert, HealthResponse } from '../types/domain.js';

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

export async function fetchDashboardStats(): Promise<DashboardStats> {
  const [health, portfolioData, alertsData] = await Promise.all([
    api.get<HealthResponse>('/health').catch(() => null),
    api
      .get<{ portfolio: Array<{ verdict: string; suggestedListPrice?: number }> }>('/portfolio')
      .catch(() => ({ portfolio: [] })),
    api.get<{ alerts: Alert[] }>('/alerts').catch(() => ({ alerts: [] })),
  ]);

  const portfolio = portfolioData.portfolio;
  const alerts = alertsData.alerts;

  return {
    totalDomains: portfolio.length,
    keepCount: portfolio.filter((p) => p.verdict === 'keep').length,
    dropCount: portfolio.filter((p) => p.verdict === 'drop').length,
    repriceCount: portfolio.filter((p) => p.verdict === 'reprice' || p.verdict === 'hold').length,
    totalListValue: portfolio.reduce((sum, p) => sum + (p.suggestedListPrice ?? 0), 0),
    activeAlertCount: alerts.filter((a) => !a.acknowledgedAt).length,
    recentAlerts: alerts.filter((a) => !a.acknowledgedAt).slice(0, 5),
    health,
  };
}
