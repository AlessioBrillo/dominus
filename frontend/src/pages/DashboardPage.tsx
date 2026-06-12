import { useEffect, useState } from 'react';
import { fetchDashboardStats, type DashboardStats } from '../api/dashboard.js';

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboardStats()
      .then(setStats)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="text-gray-500 animate-pulse">Loading dashboard...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100">Dashboard</h2>
        <p className="text-sm text-gray-500 mt-1">
          DOMINUS v{stats?.health?.version ?? '?'} — {stats?.health?.status ?? 'unknown'}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Portfolio Domains" value={stats?.totalDomains ?? 0} color="text-cyan-400" />
        <StatCard label="Keep / Drop" value={`${stats?.keepCount ?? 0} / ${stats?.dropCount ?? 0}`} color="text-emerald-400" />
        <StatCard label="Portfolio Value" value={`€${(stats?.totalListValue ?? 0).toFixed(0)}`} color="text-purple-400" />
        <StatCard label="Active Alerts" value={stats?.activeAlertCount ?? 0} color={(stats?.activeAlertCount ?? 0) > 0 ? 'text-red-400' : 'text-gray-400'} />
      </div>

      {stats?.recentAlerts && stats.recentAlerts.length > 0 && (
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">
            Active Alerts
          </h3>
          <div className="space-y-2">
            {stats.recentAlerts.map((alert) => (
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

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">Verdict Breakdown</h3>
          <div className="space-y-3">
            <VerdictBar label="Keep" count={stats?.keepCount ?? 0} total={stats?.totalDomains ?? 1} color="bg-emerald-500" />
            <VerdictBar label="Reprice" count={stats?.repriceCount ?? 0} total={stats?.totalDomains ?? 1} color="bg-amber-500" />
            <VerdictBar label="Drop" count={stats?.dropCount ?? 0} total={stats?.totalDomains ?? 1} color="bg-red-500" />
          </div>
        </div>
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-5">
          <h3 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">System Info</h3>
          <div className="space-y-2 text-sm">
            <InfoRow label="Version" value={stats?.health?.version ?? '—'} />
            <InfoRow label="Uptime" value={stats?.health?.uptime != null ? `${Math.floor(stats.health.uptime / 3600)}h ${Math.floor((stats.health.uptime % 3600) / 60)}m` : '—'} />
            <InfoRow label="API Status" value={stats?.health?.status ?? 'unknown'} />
          </div>
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

function VerdictBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>{label}</span>
        <span>{count} ({pct.toFixed(0)}%)</span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-200 font-mono">{value}</span>
    </div>
  );
}
