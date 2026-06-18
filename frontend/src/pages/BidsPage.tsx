import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { listBids, placeBid, resolveBid } from '@/api/bids';
import type { Bid } from '@/types/domain';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type Filter = 'all' | 'pending' | 'won' | 'lost';

export function BidsPage() {
  const [bids, setBids] = useState<Bid[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [domain, setDomain] = useState('');
  const [amount, setAmount] = useState('');
  const [venue, setVenue] = useState('');
  const [placing, setPlacing] = useState(false);
  const [resolveTarget, setResolveTarget] = useState<Bid | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listBids();
      setBids(result.bids);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load bids');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = filter === 'all' ? bids : bids.filter((b) => b.status === filter);

  const handlePlaceBid = async () => {
    if (!domain || !amount) return;
    setPlacing(true);
    try {
      await placeBid({
        domain: domain.trim(),
        bidAmountEur: Number.parseFloat(amount),
        venue: venue.trim() || undefined,
      });
      setDomain('');
      setAmount('');
      setVenue('');
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to place bid');
    } finally {
      setPlacing(false);
    }
  };

  const handleResolve = async (status: 'won' | 'lost' | 'cancelled' | 'outbid') => {
    if (!resolveTarget) return;
    try {
      await resolveBid({ domain: resolveTarget.domain, status });
      setResolveTarget(null);
      load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to resolve bid');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-text-primary">Bids</h2>
        <Button variant="outline" onClick={load}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Place New Bid</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-3">
            <Input
              placeholder="Domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
            <Input
              placeholder="Max Bid (€)"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Input
              placeholder="Venue (optional)"
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
            />
            <Button onClick={handlePlaceBid} disabled={placing || !domain || !amount}>
              {placing ? 'Placing...' : 'Place Bid'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        {(['all', 'pending', 'won', 'lost'] as Filter[]).map((f) => (
          <Button
            key={f}
            variant={filter === f ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
            {f !== 'all' && (
              <Badge
                variant={f === 'pending' ? 'warning' : f === 'won' ? 'success' : 'danger'}
                className="ml-1"
              >
                {bids.filter((b) => b.status === f).length}
              </Badge>
            )}
          </Button>
        ))}
      </div>

      {loading ? (
        <Card>
          <CardContent className="space-y-3 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-danger text-sm">{error}</p>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-text-muted">
            No bids found. Place your first bid above.
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-bg-muted">
                {['Domain', 'Amount', 'Venue', 'Date', 'Status', 'Actions'].map((h) => (
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
              {filtered.map((bid) => (
                <tr
                  key={bid.id ?? bid.domain}
                  className="border-b border-border hover:bg-bg-hover transition-colors"
                >
                  <td className="py-3 px-4 font-mono text-sm text-text-primary">{bid.domain}</td>
                  <td className="py-3 px-4 font-mono text-sm text-text-primary">
                    €{bid.bidAmountEur.toFixed(2)}
                  </td>
                  <td className="py-3 px-4 text-sm text-text-secondary">{bid.venue || '—'}</td>
                  <td className="py-3 px-4 text-sm text-text-secondary">
                    {new Date(bid.bidPlacedAt).toLocaleDateString()}
                  </td>
                  <td className="py-3 px-4">
                    <Badge
                      variant={
                        bid.status === 'pending'
                          ? 'warning'
                          : bid.status === 'won'
                            ? 'success'
                            : 'danger'
                      }
                    >
                      {bid.status}
                    </Badge>
                  </td>
                  <td className="py-3 px-4">
                    {bid.status === 'pending' && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="success" onClick={() => setResolveTarget(bid)}>
                          Won
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => handleResolve('lost')}>
                          Lost
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleResolve('cancelled')}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <AlertDialog
        open={!!resolveTarget}
        onOpenChange={(o) => {
          if (!o) setResolveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Win</AlertDialogTitle>
            <AlertDialogDescription>
              Mark {resolveTarget?.domain} as won at €{resolveTarget?.bidAmountEur.toFixed(2)}?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => handleResolve('won')}>Confirm Win</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
