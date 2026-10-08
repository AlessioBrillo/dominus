// SPDX-License-Identifier: AGPL-3.0-only
import type { ListingProvider } from './listing-provider.js';
import { ManualListingProvider } from './manual-listing-provider.js';
import type { ListingRepository } from '../../db/repositories/listing-repository.js';

export type { ListingProvider, SyncResult } from './listing-provider.js';
export { ManualListingProvider } from './manual-listing-provider.js';

/**
 * Only `manual` (local tracking) is implemented. Marketplace adapters (Dan,
 * Afternic, Sedo) were removed: they targeted endpoints that were never
 * verified against the vendors' real APIs. Add one back only with verified
 * API access, as a new ListingProvider implementation plus a case below.
 */
export type ListingProviderType = 'manual';

export function createListingProvider(
  type: ListingProviderType,
  deps: { listingRepo: ListingRepository },
): ListingProvider {
  switch (type) {
    case 'manual':
      return new ManualListingProvider(deps.listingRepo);
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown listing provider type: ${_exhaustive}`);
    }
  }
}
