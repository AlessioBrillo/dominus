import { useState } from 'react';
import { RefreshCw, Plus } from 'lucide-react';
import { useOutcomesList, useRecordOutcome } from '@/hooks/useOutcomes';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';

const typeVariant: Record<string, 'success' | 'danger' | 'warning' | 'info'> = {
  sold: 'success',
  expired: 'danger',
  dropped: 'danger',
  renewed: 'info',
};

const OUTCOME_TYPES = ['sold', 'dropped', 'expired', 'renewed'] as const;

export function OutcomesPage() {
  const { data: outcomes = [], isLoading, error, refetch } = useOutcomesList();
  const recordOutcome = useRecordOutcome();

  const [domain, setDomain] = useState('');
  const [type, setType] = useState<string>('sold');
  const [salePrice, setSalePrice] = useState('');
  const [venue, setVenue] = useState('');
  const [occurredAt, setOccurredAt] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');

  const sold = outcomes.filter((o) => o.type === 'sold').length;
  const totalRevenue = outcomes
    .filter((o) => o.type === 'sold' && o.salePriceEur != null)
    .reduce((sum, o) => sum + (o.salePriceEur ?? 0), 0);
  const expired = outcomes.filter((o) => o.type === 'expired' || o.type === 'dropped').length;

  const handleRecord = async () => {
    if (!domain) return;
    try {
      const result = await recordOutcome.mutateAsync({
        domain: domain.trim(),
        type: type as 'sold' | 'dropped' | 'expired' | 'renewed',
        occurredAt: new Date(occurredAt).toISOString(),
        salePriceEur: salePrice ? Number.parseFloat(salePrice) : undefined,
        venue: venue.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      setDomain('');
      setSalePrice('');
      setVenue('');
      setOccurredAt(new Date().toISOString().slice(0, 10));
      setNotes('');
      if (type === 'sold' && result.salePriceEur) {
        toast.success(
          `Sale of €${result.salePriceEur.toFixed(0)} recorded — backtest will run shortly`,
        );
      } else {
        toast.success('Outcome recorded');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to record outcome';
      toast.error(msg);
    }
  };

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

      <Card>
        <CardHeader>
          <CardTitle>Record Outcome</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Input
              placeholder="Domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="flex h-10 w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {OUTCOME_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </option>
              ))}
            </select>
            {type === 'sold' && (
              <Input
                placeholder="Sale Price (€)"
                type="number"
                value={salePrice}
                onChange={(e) => setSalePrice(e.target.value)}
              />
            )}
            <Input
              placeholder="Venue (optional)"
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
            />
            <Input type="date" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
            <Input
              placeholder="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <Button
              onClick={handleRecord}
              disabled={recordOutcome.isPending || !domain}
              className="sm:col-span-2 lg:col-span-1"
            >
              <Plus className="h-4 w-4 mr-2" />
              {recordOutcome.isPending ? 'Recording...' : 'Record'}
            </Button>
          </div>
        </CardContent>
      </Card>

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
            No outcomes recorded yet. Use the form above to record your first sale or portfolio
            event.
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
