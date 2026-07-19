import { RefreshCw, CheckCircle, XCircle } from 'lucide-react';
import { useProviderStatuses } from '@/hooks/useProviders';
import { PageHeader } from '@/components/PageHeader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';

function ProviderIcon({ configured }: { configured: boolean }) {
  if (configured) {
    return <CheckCircle className="h-5 w-5 text-success" />;
  }
  return <XCircle className="h-5 w-5 text-text-muted" />;
}

export function ProvidersPage() {
  const { data: providers = [], isLoading, error, refetch } = useProviderStatuses();

  const configured = providers.filter((p) => p.configured).length;
  const unconfigured = providers.filter((p) => !p.configured).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Providers"
        subtitle="External data source configuration status"
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            Refresh
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Configured</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-success">{configured}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Unconfigured</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-text-muted">{unconfigured}</div>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center text-danger text-sm">
            {error instanceof Error ? error.message : 'Failed to load provider status'}
          </CardContent>
        </Card>
      ) : providers.length === 0 ? (
        <EmptyState
          title="No provider data"
          description="No provider status information available."
        />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-bg-muted">
                {['Provider', 'Status', 'Details'].map((h) => (
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
              {providers.map((p) => (
                <tr
                  key={p.name}
                  className="border-b border-border hover:bg-bg-hover transition-colors"
                >
                  <td className="py-3 px-4 font-medium text-sm text-text-primary">{p.name}</td>
                  <td className="py-3 px-4">
                    <ProviderIcon configured={p.configured} />
                  </td>
                  <td className="py-3 px-4 text-sm text-text-secondary">{p.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
