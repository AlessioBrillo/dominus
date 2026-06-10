import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import type { HealthResponse, PortfolioEntry, Alert } from '../types/domain.js';

export function DashboardPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioEntry[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<{ status: string; uptime: number; version: string; timestamp: string }>('/api/health'),
      api.get<{ portfolio: PortfolioEntry[] }>('/api/portfolio').catch(() => ({ portfolio: [] })),
      api.get<{ alerts: Alert[] }>('/api/alerts').catch(() => ({ alerts: [] })),
    ])
      .then(([h, p, a]) => {
        setHealth(h);
        setPortfolio(p.portfolio);
        setAlerts(a.alerts);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-gray-500 animate-pulse">Loading dashboard...</div>;
  }

  const activeAlerts = alerts.filter((a) => !a.acknowledgedAt);
  const keepCount = portfolio.filter((p) => p.verdict === 'keep').length;
  const dropCount = portfolio.filter((p) => p.verdict === 'drop').length;
  const totalValue =
    portfolio.reduce((sum, p) => sum + (p.suggestedListPrice ?? 0), 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100">Dashboard</h2>
        <p className="text-sm text-gray-500 mt-1">
          DOMINUS v{health?.version ?? '?'} — {health?.status ?? 'unknown'}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Portfolio Domains" value={portfolio.length} color="text-cyan-400" />
        <StatCard label="Keep / Drop" value={`${keepCount} / ${dropCount}`} color="text-emerald-400" />
        <StatCard label="Portfolio Value" value={`€${totalValue.toFixed(0)}`} color="text-purple-400" />
        <StatCard label="Active Alerts" value={activeAlerts.length} color={activeAlerts.length > 0 ? 'text-red-400' : 'text-gray-400'} />
      </div>

      {activeAlerts.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
            Active Alerts
          </h3>
          <div className="space-y-2">
            {activeAlerts.slice(0, 5).map((alert) => (
              <div
                key={alert.id}
                className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                  alert.severity === 'critical'
                    ? 'bg-red-950/50 border border-red-900'
                    : 'bg-amber-950/30 border border-amber-900/50'
                }`}
              >
                <div>
                  <span className="font-medium text-gray-200">{alert.domain}</span>
                  <span className="text-gray-400 ml-2">{alert.message}</span>
                </div>
                <span className={`text-xs font-medium ${alert.severity === 'critical' ? 'text-red-400' : 'text-amber-400'}`}>
                  {alert.severity}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
          Recent Portfolio
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 text-xs uppercase">
                <th className="pb-2 pr-4">Domain</th>
                <th className="pb-2 pr-4">Verdict</th>
                <th className="pb-2 pr-4">Score</th>
                <th className="pb-2 pr-4">List Price</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.slice(0, 5).map((entry) => (
                <tr key={entry.id} className="border-t border-gray-800">
                  <td className="py-2 pr-4 text-gray-200">{entry.domain}</td>
                  <td className="py-2 pr-4">
                    <span className={`text-xs font-medium ${
                      entry.verdict === 'keep' ? 'text-emerald-400' : entry.verdict === 'drop' ? 'text-red-400' : 'text-amber-400'
                    }`}>
                      {entry.verdict}
                    </span>
                  </td>
                  <td className="py-2 pr-4 font-mono text-gray-300">
                    {entry.currentScore?.toFixed(2) ?? '—'}
                  </td>
                  <td className="py-2 pr-4 font-mono text-gray-300">
                    {entry.suggestedListPrice ? `€${entry.suggestedListPrice.toFixed(2)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 p-4">
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className={`text-2xl font-bold mt-1 font-mono ${color}`}>{value}</div>
    </div>
  );
}
