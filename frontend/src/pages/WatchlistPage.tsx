import { useState } from 'react';
import { RefreshCw, Plus, Trash2, Search } from 'lucide-react';
import {
  useWatchlistList,
  useAddToWatchlist,
  useRemoveFromWatchlist,
  usePollWatchlist,
} from '@/hooks/useWatchlist';
import { StatusBadge } from '@/components/StatusBadge';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { MetricCard } from '@/components/MetricCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

export function WatchlistPage() {
  const { data: entries = [], isLoading, error } = useWatchlistList();
  const addToWatchlist = useAddToWatchlist();
  const removeFromWatchlist = useRemoveFromWatchlist();
  const pollWatchlist = usePollWatchlist();

  const [domain, setDomain] = useState('');
  const [notes, setNotes] = useState('');

  const availableCount = entries.filter((e) => e.isAvailable === true).length;
  const unavailableCount = entries.filter((e) => e.isAvailable === false).length;
  const unknownCount = entries.filter((e) => e.isAvailable == null).length;

  const handleAdd = async () => {
    if (!domain.trim()) return;
    try {
      await addToWatchlist.mutateAsync({ domain: domain.trim(), notes: notes.trim() || undefined });
      setDomain('');
      setNotes('');
    } catch {
      /* handled by hook */
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Watchlist"
        subtitle="Monitor domains for availability changes"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => pollWatchlist.mutate()}
            disabled={pollWatchlist.isPending || entries.length === 0}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 mr-1 ${pollWatchlist.isPending ? 'animate-spin' : ''}`}
            />
            {pollWatchlist.isPending ? 'Polling...' : 'Poll Now'}
          </Button>
        }
      />

      <div className="grid grid-cols-3 gap-4">
        <MetricCard label="Available" value={String(availableCount)} accent="text-success" />
        <MetricCard label="Unavailable" value={String(unavailableCount)} accent="text-danger" />
        <MetricCard label="Unknown" value={String(unknownCount)} accent="text-text-muted" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Add Domain</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <Input
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="flex-1"
            />
            <Input
              placeholder="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="flex-1"
            />
            <Button onClick={handleAdd} disabled={addToWatchlist.isPending || !domain.trim()}>
              <Plus className="h-4 w-4 mr-1" />
              {addToWatchlist.isPending ? 'Adding...' : 'Add'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-danger text-sm">
              {error instanceof Error ? error.message : 'Failed to load watchlist'}
            </p>
          </CardContent>
        </Card>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Search className="h-8 w-8" />}
          title="No domains on watchlist"
          description="Add domains above to monitor them for availability changes. The scheduler polls them every 6 hours."
        />
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-bg-muted">
                {['Domain', 'Status', 'Last Polled', 'Added', 'Notes', ''].map((h) => (
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
              {entries.map((entry) => (
                <tr
                  key={entry.domain}
                  className="border-b border-border hover:bg-bg-hover transition-colors"
                >
                  <td className="py-3 px-4 font-mono text-sm text-text-primary">{entry.domain}</td>
                  <td className="py-3 px-4">
                    {entry.isAvailable === true ? (
                      <StatusBadge status="completed" />
                    ) : entry.isAvailable === false ? (
                      <StatusBadge status="expired" />
                    ) : (
                      <StatusBadge status="pending" />
                    )}
                  </td>
                  <td className="py-3 px-4 text-sm text-text-secondary">
                    {entry.lastPolledAt ? new Date(entry.lastPolledAt).toLocaleString() : '—'}
                  </td>
                  <td className="py-3 px-4 text-sm text-text-secondary">
                    {new Date(entry.addedAt).toLocaleDateString()}
                  </td>
                  <td className="py-3 px-4 text-sm text-text-muted">{entry.notes ?? '—'}</td>
                  <td className="py-3 px-4">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-text-muted hover:text-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Remove from watchlist?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Stop monitoring {entry.domain} for availability changes.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => removeFromWatchlist.mutate(entry.domain)}
                            className="bg-danger hover:bg-danger/90"
                          >
                            Remove
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
