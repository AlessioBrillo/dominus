// SPDX-License-Identifier: AGPL-3.0-only
import type { ListingProvider } from './listing-provider.js';
import { ManualListingProvider } from './manual-listing-provider.js';
import { DanListingProvider } from './dan-listing-provider.js';
import { AfternicListingProvider } from './afternic-listing-provider.js';
import type { ListingRepository } from '../../db/repositories/listing-repository.js';

export type { ListingProvider, SyncResult } from './listing-provider.js';
export { ManualListingProvider } from './manual-listing-provider.js';
export { DanListingProvider } from './dan-listing-provider.js';
export { AfternicListingProvider } from './afternic-listing-provider.js';

export type ListingProviderType = 'manual' | 'dan' | 'afternic';

export function createListingProvider(
  type: ListingProviderType,
  deps: {
    listingRepo: ListingRepository;
    danApiKey: string | undefined;
    afternicApiKey?: string | undefined;
    afternicApiUrl?: string | undefined;
  },
): ListingProvider {
  switch (type) {
    case 'manual':
      return new ManualListingProvider(deps.listingRepo);
    case 'dan':
      return new DanListingProvider(deps.danApiKey);
    case 'afternic':
      return new AfternicListingProvider(deps.afternicApiKey, deps.afternicApiUrl);
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown listing provider type: ${_exhaustive}`);
    }
  }
}
