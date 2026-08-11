// SPDX-License-Identifier: AGPL-3.0-only
import { ShieldAlert } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fetchAdminOverview, fetchAdminTenants } from '@/api/admin';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';

const usageColumns = ['candidates_scored', 'api_calls', 'domains_tracked'] as const;

function formatUsage(used: number | undefined, limit: number | null | undefined): string {
  const usedText = String(used ?? 0);
  if (limit === null || limit === undefined) return usedText;
  return `${usedText} / ${limit}`;
}

export function AdminPage() {
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: fetchAdminOverview,
    staleTime: 30_000,
  });
  const tenants = useQuery({
    queryKey: ['admin', 'tenants'],
    queryFn: fetchAdminTenants,
    staleTime: 30_000,
  });

  if (overview.isLoading || tenants.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full rounded-xl" />
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (overview.error || tenants.error) {
    const message =
      overview.error instanceof Error ? overview.error.message : 'Failed to load admin data';
    return (
      <div className="space-y-6">
        <PageHeader title="Admin" subtitle="Platform administration (DOMINUS Cloud)" />
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
            <ShieldAlert className="h-8 w-8 text-danger" />
            <p className="text-danger text-sm">{message}</p>
            <p className="text-text-muted text-xs">
              This view requires an admin API key. Create one with the CLI key-management command.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const data = overview.data!;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin"
        subtitle={`Platform overview — period ${data.periodStart} to ${data.periodEnd}`}
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Tenants</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{data.tenantsCount}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active subs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-success">
              {data.activeSubscriptions}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Paid plans</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-brand-300">{data.paidPlans}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Candidates scored</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{data.candidatesScoredTotal}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>API calls</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono">{data.apiCallsTotal}</div>
          </CardContent>
        </Card>
      </div>

      {tenants.data!.length === 0 ? (
        <EmptyState title="No tenants" description="No tenant activity has been recorded yet." />
      ) : (
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="bg-bg-muted">
                {[
                  'Tenant',
                  'Plan',
                  'Status',
                  'Keys',
                  'Last active',
                  'Candidates',
                  'API calls',
                  'Domains',
                ].map((h) => (
                  <th
                    key={h}
                    className="text-left py-3 px-4 text-xs font-medium text-text-muted uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-bg-elevated">
              {tenants.data!.map((t) => {
                const usage = Object.fromEntries(t.usage.map((u) => [u.feature, u]));
                return (
                  <tr key={t.tenantId} className="border-t border-border">
                    <td className="py-3 px-4 font-mono text-sm">{t.tenantId}</td>
                    <td className="py-3 px-4 text-sm capitalize">{t.plan}</td>
                    <td className="py-3 px-4 text-sm capitalize">{t.status}</td>
                    <td className="py-3 px-4 text-sm font-mono">{t.apiKeyCount}</td>
                    <td className="py-3 px-4 text-sm text-text-muted">
                      {t.lastActiveAt ? new Date(t.lastActiveAt).toLocaleString() : '—'}
                    </td>
                    {usageColumns.map((feature) => (
                      <td key={feature} className="py-3 px-4 text-sm font-mono">
                        {formatUsage(usage[feature]?.used, usage[feature]?.limit)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
