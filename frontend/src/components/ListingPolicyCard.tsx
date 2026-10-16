// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useListingSettings, useUpdateListingSettings } from '@/hooks/useListings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';

/**
 * Tenant listing policy (ADR-0083, M4): the base price new automatic
 * listings use, and the rules that answer incoming offers. Both default
 * to conservative values — the scoring price and no automatic answers.
 */
export function ListingPolicyCard() {
  const { data: settings, isLoading } = useListingSettings();
  const update = useUpdateListingSettings();

  const [pricePolicy, setPricePolicy] = useState<'scoring' | 'fixed'>('scoring');
  const [basePrice, setBasePrice] = useState('');
  const [declineFloor, setDeclineFloor] = useState('');
  const [counterPrice, setCounterPrice] = useState('');

  useEffect(() => {
    if (!settings) return;
    setPricePolicy(settings.pricePolicy);
    setBasePrice(settings.basePriceEur !== null ? String(settings.basePriceEur) : '');
    setDeclineFloor(
      settings.offerAutoDeclineBelowEur !== null ? String(settings.offerAutoDeclineBelowEur) : '',
    );
    setCounterPrice(settings.offerCounterEur !== null ? String(settings.offerCounterEur) : '');
  }, [settings]);

  const parseOptional = (value: string): number | null | 'invalid' => {
    if (value.trim() === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return 'invalid';
    return parsed;
  };

  const handleSave = async () => {
    const parsedBase = parseOptional(basePrice);
    const parsedDecline = parseOptional(declineFloor);
    const parsedCounter = parseOptional(counterPrice);
    if (parsedBase === 'invalid' || parsedDecline === 'invalid' || parsedCounter === 'invalid') {
      toast.error('Prices must be numbers of zero or more');
      return;
    }
    if (pricePolicy === 'fixed' && (parsedBase === null || parsedBase <= 0)) {
      toast.error('A fixed price policy needs a base price above zero');
      return;
    }

    try {
      await update.mutateAsync({
        pricePolicy,
        basePriceEur: parsedBase,
        offerAutoDeclineBelowEur: parsedDecline,
        offerCounterEur: parsedCounter,
      });
      toast.success('Listing policy saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the listing policy');
    }
  };

  if (isLoading) {
    return <Skeleton className="h-48 w-full rounded-lg" />;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Listing policy</CardTitle>
        <CardDescription>
          Base price for new automatic listings and the rules that answer incoming offers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="text-sm font-medium text-text-primary">Listing price</div>
          <div className="flex gap-2" role="group" aria-label="Listing price policy">
            <Button
              variant={pricePolicy === 'scoring' ? 'default' : 'outline'}
              size="sm"
              aria-pressed={pricePolicy === 'scoring'}
              onClick={() => setPricePolicy('scoring')}
            >
              Scoring price
            </Button>
            <Button
              variant={pricePolicy === 'fixed' ? 'default' : 'outline'}
              size="sm"
              aria-pressed={pricePolicy === 'fixed'}
              onClick={() => setPricePolicy('fixed')}
            >
              My base price
            </Button>
          </div>
          <Input
            type="number"
            min={0}
            placeholder="Base price (€)"
            aria-label="Base price"
            value={basePrice}
            disabled={pricePolicy !== 'fixed'}
            onChange={(e) => setBasePrice(e.target.value)}
          />
          <p className="text-xs text-text-muted">
            {pricePolicy === 'scoring'
              ? 'New automatic listings use the conservative price computed by the scoring engine.'
              : 'New automatic listings use your base price instead of the scoring price.'}
          </p>
        </div>

        <div className="space-y-2 border-t border-border pt-4">
          <div className="text-sm font-medium text-text-primary">Offer rules</div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="offer-decline-floor" className="text-xs text-text-muted block mb-1">
                Auto-decline below (€)
              </label>
              <Input
                id="offer-decline-floor"
                type="number"
                min={0}
                placeholder="Off"
                value={declineFloor}
                onChange={(e) => setDeclineFloor(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="offer-counter-price" className="text-xs text-text-muted block mb-1">
                Counter below (€)
              </label>
              <Input
                id="offer-counter-price"
                type="number"
                min={0}
                placeholder="Off"
                value={counterPrice}
                onChange={(e) => setCounterPrice(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-text-muted">
            Leave a field empty to keep those offers pending for your decision. The decline floor is
            checked first, so it always wins over the counter rule.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? 'Saving…' : 'Save policy'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
