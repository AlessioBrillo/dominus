import { useState } from 'react';
import { RefreshCw, Plus, ExternalLink } from 'lucide-react';
import {
  useListingsList,
  useCreateListing,
  usePublishListing,
  useDeleteListing,
  useSyncListings,
  useAcceptOffer,
  useDeclineOffer,
} from '@/hooks/useListings';
import type { Listing, ListingOffer } from '@/types/domain';
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
import { toast } from 'sonner';

type Filter = 'all' | 'draft' | 'listed' | 'offer_received' | 'sold';

const MARKETPLACES = ['dan', 'afternic', 'sedo', 'godaddy', 'manual'] as const;

function statusVariant(
  status: string,
): 'default' | 'outline' | 'success' | 'warning' | 'danger' | 'info' {
  switch (status) {
    case 'draft':
      return 'default';
    case 'listed':
      return 'success';
    case 'offer_received':
      return 'warning';
    case 'sold':
      return 'info';
    case 'expired':
      return 'outline';
    default:
      return 'default';
  }
}

export function ListingsPage() {
  const { data: listings = [], isLoading, error, refetch } = useListingsList();
  const createListing = useCreateListing();
  const publishListing = usePublishListing();
  const deleteListing = useDeleteListing();
  const syncListings = useSyncListings();
  const acceptOffer = useAcceptOffer();
  const declineOffer = useDeclineOffer();

  const [filter, setFilter] = useState<Filter>('all');
  const [domain, setDomain] = useState('');
  const [price, setPrice] = useState('');
  const [marketplace, setMarketplace] = useState<string>('manual');
  const [expandedListing, setExpandedListing] = useState<Listing | null>(null);
  const [offers, setOffers] = useState<ListingOffer[]>([]);
  const [loadingOffers, setLoadingOffers] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Listing | null>(null);

  const filtered = filter === 'all' ? listings : listings.filter((l) => l.status === filter);

  const handleCreate = async () => {
    if (!domain) return;
    try {
      await createListing.mutateAsync({
        domain: domain.trim(),
        marketplace,
        price: price ? Number.parseFloat(price) : undefined,
      });
      setDomain('');
      setPrice('');
      toast.success('Listing created');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create listing');
    }
  };

  const handlePublish = async (id: number) => {
    try {
      await publishListing.mutateAsync(id);
      toast.success('Listing published');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to publish');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteListing.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
      toast.success('Listing deleted');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const handleSync = async () => {
    try {
      const result = await syncListings.mutateAsync();
      toast.success(`Synced ${result.listings.length} listings, ${result.offers.length} offers`);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Sync failed');
    }
  };

  const handleExpand = async (listing: Listing) => {
    setExpandedListing(listing);
    setLoadingOffers(true);
    try {
      const { getListing } = await import('@/api/listings');
      const data = await getListing(listing.id);
      setOffers(data.offers);
    } catch {
      setOffers([]);
    } finally {
      setLoadingOffers(false);
    }
  };

  const handleAcceptOffer = async (offerId: number) => {
    if (!expandedListing) return;
    try {
      await acceptOffer.mutateAsync({ listingId: expandedListing.id, offerId });
      toast.success('Offer accepted');
      handleExpand(expandedListing);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to accept');
    }
  };

  const handleDeclineOffer = async (offerId: number) => {
    if (!expandedListing) return;
    try {
      await declineOffer.mutateAsync({ listingId: expandedListing.id, offerId });
      toast.success('Offer declined');
      handleExpand(expandedListing);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to decline');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-text-primary">Listings</h2>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleSync} disabled={syncListings.isPending}>
            <RefreshCw className={`h-4 w-4 mr-2 ${syncListings.isPending ? 'animate-spin' : ''}`} />
            Sync
          </Button>
          <Button variant="outline" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New Listing</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-3">
            <Input
              placeholder="Domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
            <Input
              placeholder="Price (€) — optional"
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <select
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value)}
              className="flex h-10 w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {MARKETPLACES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <Button onClick={handleCreate} disabled={createListing.isPending || !domain}>
              <Plus className="h-4 w-4 mr-2" />
              {createListing.isPending ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2 flex-wrap">
        {(['all', 'draft', 'listed', 'offer_received', 'sold'] as Filter[]).map((f) => (
          <Button
            key={f}
            variant={filter === f ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(f)}
          >
            {f === 'all'
              ? 'All'
              : f
                  .split('_')
                  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                  .join(' ')}
            {f !== 'all' && (
              <Badge variant={statusVariant(f)} className="ml-1">
                {listings.filter((l) => l.status === f).length}
              </Badge>
            )}
          </Button>
        ))}
      </div>

      {isLoading ? (
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
            <p className="text-danger text-sm">
              {error instanceof Error ? error.message : 'Failed to load listings'}
            </p>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-text-muted">
            No listings found. Create one above.
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-bg-muted">
                {['Domain', 'Marketplace', 'Price', 'Status', 'Created', 'Actions'].map((h) => (
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
              {filtered.map((listing) => (
                <tr
                  key={listing.id}
                  className="border-b border-border hover:bg-bg-hover transition-colors"
                >
                  <td className="py-3 px-4 font-mono text-sm text-text-primary">
                    {listing.domain}
                  </td>
                  <td className="py-3 px-4 text-sm text-text-secondary">{listing.marketplace}</td>
                  <td className="py-3 px-4 font-mono text-sm text-text-primary">
                    €{listing.priceEur.toFixed(2)}
                  </td>
                  <td className="py-3 px-4">
                    <Badge variant={statusVariant(listing.status)}>
                      {listing.status === 'offer_received' ? 'Offer' : listing.status}
                    </Badge>
                  </td>
                  <td className="py-3 px-4 text-sm text-text-secondary">
                    {new Date(listing.createdAt).toLocaleDateString()}
                  </td>
                  <td className="py-3 px-4">
                    <div className="flex gap-1">
                      {listing.status === 'draft' && (
                        <Button
                          size="sm"
                          variant="success"
                          onClick={() => handlePublish(listing.id)}
                        >
                          Publish
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => handleExpand(listing)}>
                        <ExternalLink className="h-3 w-3 mr-1" />
                        Offers
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => setDeleteTarget(listing)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Offers Dialog */}
      <AlertDialog
        open={!!expandedListing}
        onOpenChange={(o) => {
          if (!o) {
            setExpandedListing(null);
            setOffers([]);
          }
        }}
      >
        <AlertDialogContent className="max-w-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Offers for {expandedListing?.domain}</AlertDialogTitle>
            <AlertDialogDescription>
              Marketplace: {expandedListing?.marketplace} — €{expandedListing?.priceEur.toFixed(2)}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {loadingOffers ? (
            <div className="py-4 text-center text-sm text-text-muted">Loading offers...</div>
          ) : offers.length === 0 ? (
            <div className="py-4 text-center text-sm text-text-muted">No offers received yet.</div>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {offers.map((offer) => (
                <div
                  key={offer.id}
                  className="flex items-center justify-between p-3 rounded-lg bg-bg-muted"
                >
                  <div>
                    <p className="text-sm font-medium text-text-primary">
                      €{offer.amountEur.toFixed(2)} — {offer.buyer}
                    </p>
                    <p className="text-xs text-text-muted">
                      {new Date(offer.receivedAt).toLocaleString()} · Status: {offer.status}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {offer.status === 'pending' && (
                      <>
                        <Button
                          size="sm"
                          variant="success"
                          onClick={() => handleAcceptOffer(offer.id)}
                        >
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => handleDeclineOffer(offer.id)}
                        >
                          Decline
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Listing</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the listing for {deleteTarget?.domain}?
              {deleteTarget?.status === 'listed' && (
                <span className="block mt-2 text-warning">
                  This listing is currently published and will be removed from the marketplace.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
