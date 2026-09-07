// SPDX-License-Identifier: AGPL-3.0-only
import type { ListingProvider } from './listing-provider.js';
import { ManualListingProvider } from './manual-listing-provider.js';
import { DanListingProvider } from './dan-listing-provider.js';
import { AfternicListingProvider } from './afternic-listing-provider.js';
import { SedoListingProvider } from './sedo-listing-provider.js';
import type { ListingRepository } from '../../db/repositories/listing-repository.js';

export type { ListingProvider, SyncResult } from './listing-provider.js';
export { ManualListingProvider } from './manual-listing-provider.js';
export { DanListingProvider } from './dan-listing-provider.js';
export { AfternicListingProvider } from './afternic-listing-provider.js';
export { SedoListingProvider } from './sedo-listing-provider.js';
export { safeRemoteNumericId, MAX_SYNC_PAGES } from './remote-id.js';

export type ListingProviderType = 'manual' | 'dan' | 'afternic' | 'sedo';

export function createListingProvider(
  type: ListingProviderType,
  deps: {
    listingRepo: ListingRepository;
    danApiKey: string | undefined;
    afternicApiKey?: string | undefined;
    afternicApiUrl?: string | undefined;
    sedoApiKey?: string | undefined;
    sedoApiUrl?: string | undefined;
  },
): ListingProvider {
  switch (type) {
    case 'manual':
      return new ManualListingProvider(deps.listingRepo);
    case 'dan':
      return new DanListingProvider(deps.danApiKey);
    case 'afternic':
      return new AfternicListingProvider(deps.afternicApiKey, deps.afternicApiUrl);
    case 'sedo':
      return new SedoListingProvider(deps.sedoApiKey, deps.sedoApiUrl);
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown listing provider type: ${_exhaustive}`);
    }
  }
}
