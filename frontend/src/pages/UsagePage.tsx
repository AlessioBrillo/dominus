// SPDX-License-Identifier: AGPL-3.0-only
import { BarChart, Bar, XAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { fetchUsageHistory, type UsageFeature } from '@/api/usage';
import { queryKeys } from '@/hooks/query-keys';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';

const featureLabels: Record<UsageFeature, string> = {
  candidates_scored: 'Candidates scored',
  api_calls: 'API calls',
  domains_tracked: 'Domains tracked',
};

function formatUsage(used: number, limit: number | null): string {
  if (limit === null) return String(used);
  return `${used} / ${limit}`;
}

export function UsagePage() {
  const history = useQuery({
    queryKey: queryKeys.usage.history(),
    queryFn: () => fetchUsageHistory(6),
    staleTime: 30_000,
  });

  if (history.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64 rounded-xl" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (history.error) {
    return (
      <div className="space-y-6">
        <PageHeader title="Usage" subtitle="Plan consumption and monthly history (DOMINUS Cloud)" />
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
            <p className="text-danger text-sm">
              {history.error instanceof Error ? history.error.message : 'Failed to load usage'}
            </p>
            <p className="text-text-muted text-xs">
              Usage history is available with a DOMINUS Cloud subscription.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const entries = history.data ?? [];
  if (entries.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title="Usage" subtitle="Plan consumption and monthly history" />
        <EmptyState
          title="No usage history"
          description="Usage data will appear here once the pipeline starts recording metered activity."
        />
      </div>
    );
  }

  const current = entries[entries.length - 1]!;
  const chartData = entries.map((entry) => ({
    month: entry.periodStart.slice(0, 7),
    candidates: entry.usage.candidates_scored.currentUsage,
    apiCalls: entry.usage.api_calls.currentUsage,
    domains: entry.usage.domains_tracked.currentUsage,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage"
        subtitle={`Current plan: ${current.plan} — period ${current.periodStart} to ${current.periodEnd}`}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(Object.keys(featureLabels) as UsageFeature[]).map((feature) => {
          const usage = current.usage[feature];
          return (
            <Card key={feature}>
              <CardHeader>
                <CardTitle>{featureLabels[feature]}</CardTitle>
              </CardHeader>
              <CardContent>
                <div
                  className={`text-2xl font-bold font-mono ${
                    usage.isOverLimit ? 'text-danger' : ''
                  }`}
                >
                  {formatUsage(usage.currentUsage, usage.limitValue)}
                </div>
                <div className="text-xs text-text-muted mt-1">
                  {usage.isOverLimit ? 'Over plan limit' : `${usage.plan} plan limit`}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card data-testid="usage-history-chart">
        <CardHeader>
          <CardTitle>Monthly history</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData}>
              <XAxis dataKey="month" stroke="var(--text-muted)" fontSize={12} />
              <Bar dataKey="candidates" name="Candidates" fill="#6366f1" />
              <Bar dataKey="apiCalls" name="API calls" fill="#10b981" />
              <Bar dataKey="domains" name="Domains" fill="#f59e0b" />
              <Tooltip />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
