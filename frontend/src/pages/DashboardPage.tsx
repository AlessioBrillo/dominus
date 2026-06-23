import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, RefreshCw } from 'lucide-react';
import { BarChart, Bar, XAxis, ResponsiveContainer } from 'recharts';
import { useDashboardStats } from '@/hooks/useDashboard';
import { useRunPipeline } from '@/hooks/useCandidates';
import { getOnboardingState } from '@/api/onboarding';
import { RunProgress } from '@/components/RunProgress';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useState } from 'react';

export function DashboardPage() {
  const navigate = useNavigate();
  const { data: result, isLoading, error, refetch } = useDashboardStats();
  const runPipeline = useRunPipeline();
  const [runId, setRunId] = useState<string | null>(null);
  const [_onboardingCheckDone, setOnboardingCheckDone] = useState(false);

  useEffect(() => {
    getOnboardingState()
      .then((state) => {
        if (!state.completedAt) {
          navigate('/onboarding', { replace: true });
          return;
        }
        setOnboardingCheckDone(true);
      })
      .catch(() => {
        setOnboardingCheckDone(true);
      });
  }, [navigate]);

  const startPipeline = async () => {
    setRunId(null);
    try {
      const result = await runPipeline.mutateAsync();
      setRunId(result.runId);
    } catch {
      /* error handled by mutation */
    }
  };

  if (error && !result) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold text-text-primary">Dashboard</h2>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center py-12">
            <p className="text-danger text-sm mb-4">
              {error instanceof Error ? error.message : 'Failed to load dashboard'}
            </p>
            <Button variant="outline" onClick={() => refetch()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-text-primary">Dashboard</h2>
            <p className="text-sm text-text-muted mt-1 animate-pulse">Loading system data...</p>
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-3 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-7 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <Skeleton className="h-3 w-32" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-3 w-24" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-full" />
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const stats = result?.stats;
  const partialFailure = result?.partialFailure ?? false;
  const failureReasons = result?.failureReasons ?? [];

  const chartData = [
    { name: 'Keep', value: stats?.keepCount ?? 0, fill: '#10b981' },
    { name: 'Reprice', value: stats?.repriceCount ?? 0, fill: '#f59e0b' },
    { name: 'Drop', value: stats?.dropCount ?? 0, fill: '#ef4444' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text-primary">Dashboard</h2>
          <p className="text-sm text-text-muted mt-1">
            DOMINUS v{stats?.health?.version ?? '?'} — {stats?.health?.status ?? 'unknown'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={startPipeline} disabled={runPipeline.isPending}>
            {runPipeline.isPending ? (
              <span className="animate-pulse">Starting...</span>
            ) : (
              <>
                <Play className="h-4 w-4" /> Run Pipeline
              </>
            )}
          </Button>
          <Button variant="outline" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {partialFailure && (
        <div className="bg-warning/10 border border-warning/30 text-warning px-4 py-3 rounded-lg text-sm flex items-center justify-between">
          <span>
            Some data sources unavailable: {failureReasons.map((r) => `/api/v1/${r}`).join(', ')}.
            Displaying partial data.
          </span>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      <RunProgress runId={runId} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Portfolio Domains"
          value={String(stats?.totalDomains ?? 0)}
          accent="text-brand-400"
        />
        <StatCard
          label="Keep / Drop"
          value={`${stats?.keepCount ?? 0} / ${stats?.dropCount ?? 0}`}
          accent="text-success"
        />
        <StatCard
          label="Portfolio Value"
          value={`€${(stats?.totalListValue ?? 0).toFixed(0)}`}
          accent="text-accent"
        />
        <StatCard
          label="Active Alerts"
          value={String(stats?.activeAlertCount ?? 0)}
          accent={(stats?.activeAlertCount ?? 0) > 0 ? 'text-danger' : 'text-text-muted'}
        />
      </div>

      {stats?.recentAlerts && stats.recentAlerts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Active Alerts</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {stats.recentAlerts.map((alert) => (
              <div
                key={alert.id}
                className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
                  alert.severity === 'critical'
                    ? 'bg-danger/10 border border-danger/30'
                    : 'bg-warning/10 border border-warning/30'
                }`}
              >
                <div>
                  <span className="font-medium text-text-primary">{alert.domain}</span>
                  <span className="text-text-secondary ml-2">{alert.message}</span>
                </div>
                <span
                  className={`text-xs font-medium ${alert.severity === 'critical' ? 'text-danger' : 'text-warning'}`}
                >
                  {alert.severity}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Verdict Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} layout="vertical">
                  <XAxis type="number" hide />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={24} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 space-y-2">
              {chartData.map((d) => (
                <div key={d.name} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: d.fill }} />
                    <span className="text-text-secondary">{d.name}</span>
                  </div>
                  <span className="font-mono text-text-primary">{d.value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>System Info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <InfoRow label="Version" value={stats?.health?.version ?? '—'} />
            <InfoRow
              label="Uptime"
              value={
                stats?.health?.uptime != null
                  ? `${Math.floor(stats.health.uptime / 3600)}h ${Math.floor((stats.health.uptime % 3600) / 60)}m`
                  : '—'
              }
            />
            <InfoRow label="API Status" value={stats?.health?.status ?? 'unknown'} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold font-mono ${accent}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-primary font-mono">{value}</span>
    </div>
  );
}
