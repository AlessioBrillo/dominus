import { RefreshCw } from 'lucide-react';
import { useOutcomesList } from '@/hooks/useOutcomes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const typeVariant: Record<string, 'success' | 'danger' | 'warning' | 'info'> = {
  sold: 'success',
  expired: 'danger',
  dropped: 'danger',
  renewed: 'info',
};

export function OutcomesPage() {
  const { data: outcomes = [], isLoading, error, refetch } = useOutcomesList();

  const sold = outcomes.filter((o) => o.type === 'sold').length;
  const totalRevenue = outcomes
    .filter((o) => o.type === 'sold' && o.salePriceEur != null)
    .reduce((sum, o) => sum + (o.salePriceEur ?? 0), 0);
  const expired = outcomes.filter((o) => o.type === 'expired' || o.type === 'dropped').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-text-primary">Outcomes</h2>
        <Button variant="outline" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Sold</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-success">{sold}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Revenue</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-success">
              €{totalRevenue.toFixed(0)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Expired/Dropped</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono text-danger">{expired}</div>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-danger text-sm">
              {error instanceof Error ? error.message : 'Failed to load outcomes'}
            </p>
          </CardContent>
        </Card>
      ) : outcomes.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-text-muted">
            No outcomes recorded. Use the CLI to record outcomes.
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-bg-muted">
                {['Domain', 'Type', 'Date', 'Price', 'Venue', 'Notes'].map((h) => (
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
              {outcomes.map((o) => (
                <tr
                  key={o.id}
                  className="border-b border-border hover:bg-bg-hover transition-colors"
                >
                  <td className="py-3 px-4 font-mono text-sm text-text-primary">{o.domain}</td>
                  <td className="py-3 px-4">
                    <Badge variant={typeVariant[o.type] ?? 'outline'}>{o.type}</Badge>
                  </td>
                  <td className="py-3 px-4 text-sm text-text-secondary">
                    {new Date(o.occurredAt).toLocaleDateString()}
                  </td>
                  <td className="py-3 px-4 font-mono text-sm text-text-primary">
                    {o.salePriceEur != null ? `€${o.salePriceEur.toFixed(0)}` : '—'}
                  </td>
                  <td className="py-3 px-4 text-sm text-text-secondary">{o.venue ?? '—'}</td>
                  <td className="py-3 px-4 text-sm text-text-muted">{o.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
