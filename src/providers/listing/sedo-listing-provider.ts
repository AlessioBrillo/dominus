// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Listing,
  ListingOffer,
  NewListing,
  ListingUpdate,
  MarketplaceName,
  OfferStatus,
  ListingStatus,
} from '../../types/listing.js';
import type { ListingProvider, SyncResult } from './listing-provider.js';
import { MAX_SYNC_PAGES, safeRemoteNumericId } from './remote-id.js';
import { getLogger } from '../../logger.js';
import { ProviderError } from '../../types/errors.js';

const logger = getLogger();

type FetchOptions = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

interface SedoApiListing {
  id: string;
  domain: string;
  buy_now_price: number;
  status: 'active' | 'sold' | 'expired' | 'paused' | 'pending' | 'inactive';
  listing_url: string;
  created_at: string;
  expires_at: string | null;
}

interface SedoApiOffer {
  id: string;
  amount: number;
  buyer: string;
  status: 'pending' | 'accepted' | 'declined' | 'countered' | 'withdrawn';
  created_at: string;
}

interface SedoListingsResponse {
  listings: SedoApiListing[];
  total: number;
  page: number;
}

interface SedoCreateListingPayload {
  domain: string;
  buy_now_price: number;
  listing_type?: 'buy_it_now' | 'lease_to_own';
}

export const SEDO_API_BASE = 'https://api.sedo.com/v1';

function sedoStatusToInternal(status: SedoApiListing['status']): ListingStatus {
  const map: Record<SedoApiListing['status'], ListingStatus> = {
    active: 'listed',
    sold: 'sold',
    expired: 'expired',
    paused: 'paused',
    pending: 'pending',
    inactive: 'unlisted',
  };
  return map[status] ?? 'draft';
}

function internalStatusToSedo(status: ListingStatus): SedoApiListing['status'] | undefined {
  const map: Record<string, SedoApiListing['status']> = {
    listed: 'active',
    sold: 'sold',
    expired: 'expired',
    paused: 'paused',
    pending: 'pending',
    unlisted: 'inactive',
  };
  return map[status];
}

function sedoOfferStatusToInternal(status: SedoApiOffer['status']): OfferStatus {
  const map: Record<SedoApiOffer['status'], OfferStatus> = {
    pending: 'pending',
    accepted: 'accepted',
    declined: 'declined',
    countered: 'countered',
    withdrawn: 'withdrawn',
  };
  return map[status] ?? 'pending';
}

export class SedoListingProvider implements ListingProvider {
  readonly name = 'sedo';
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(apiKey: string | undefined, baseUrl: string = SEDO_API_BASE) {
    if (!apiKey) {
      logger.warn('SedoListingProvider: no API key provided — provider is unavailable');
    }
    this.#apiKey = apiKey ?? '';
    this.#baseUrl = baseUrl;
  }

  get isAvailable(): boolean {
    return this.#apiKey.length > 0;
  }

  async createListing(newListing: NewListing): Promise<Listing> {
    this.#requireAuth();

    const payload: SedoCreateListingPayload = {
      domain: newListing.domain,
      buy_now_price: newListing.priceEur,
    };

    const response = await this.#request<SedoApiListing>('/listings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    logger.info(
      { domain: newListing.domain, sedoId: response.id },
      'SedoListingProvider: listing created',
    );
    return this.#toInternal(response);
  }

  async updateListing(externalId: string, update: ListingUpdate): Promise<Listing> {
    this.#requireAuth();

    const body: Record<string, unknown> = {};
    if (update.priceEur !== undefined) body['buy_now_price'] = update.priceEur;
    if (update.status !== undefined) {
      const sedoStatus = internalStatusToSedo(update.status);
      if (sedoStatus) body['status'] = sedoStatus;
    }

    const response = await this.#request<SedoApiListing>(`/listings/${externalId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    return this.#toInternal(response);
  }

  async cancelListing(externalId: string): Promise<void> {
    this.#requireAuth();
    await this.#request(`/listings/${externalId}`, { method: 'DELETE' });
    logger.info({ sedoId: externalId }, 'SedoListingProvider: listing cancelled');
  }

  async getListing(externalId: string): Promise<Listing | undefined> {
    this.#requireAuth();
    try {
      const response = await this.#request<SedoApiListing>(`/listings/${externalId}`);
      return this.#toInternal(response);
    } catch (err) {
      if (
        err instanceof ProviderError &&
        (err.context['status'] === 404 || err.message.includes('404'))
      ) {
        return undefined;
      }
      throw err;
    }
  }

  async getListings(): Promise<Listing[]> {
    this.#requireAuth();
    return (await this.#fetchAllListings()).listings.map((l) => this.#toInternal(l));
  }

  async getOffers(externalId: string): Promise<ListingOffer[]> {
    this.#requireAuth();
    const offers = await this.#request<SedoApiOffer[]>(`/listings/${externalId}/offers`);
    return offers.map((o) => this.#toInternalOffer(o, safeRemoteNumericId(externalId)));
  }

  async sync(): Promise<SyncResult> {
    const errors: string[] = [];

    if (!this.isAvailable) {
      return {
        marketplace: 'sedo',
        listings: [],
        offers: [],
        errors: ['Sedo API key not configured'],
        syncedAt: new Date().toISOString(),
      };
    }

    // ponytail: naive page-at-a-time pagination with page size derived from
    // the first response. If Sedo API performance degrades at scale,
    // replace with concurrent page fetches.
    let allSedoListings: SedoApiListing[];
    let truncated: boolean;
    try {
      const fetched = await this.#fetchAllListings();
      allSedoListings = fetched.listings;
      truncated = fetched.truncated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'SedoListingProvider: sync failed');
      return {
        marketplace: 'sedo',
        listings: [],
        offers: [],
        errors: [msg],
        syncedAt: new Date().toISOString(),
      };
    }

    const listings: Listing[] = [];
    const allOffers: ListingOffer[] = [];
    if (truncated) {
      errors.push(
        `pagination truncated at page cap (${MAX_SYNC_PAGES} pages): re-run sync to continue`,
      );
    }

    for (const sl of allSedoListings) {
      try {
        const listing = this.#toInternal(sl);
        listings.push(listing);

        const offers = await this.#request<SedoApiOffer[]>(`/listings/${sl.id}/offers`);
        allOffers.push(...offers.map((o) => this.#toInternalOffer(o, safeRemoteNumericId(sl.id))));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${sl.domain}: ${msg}`);
      }
    }

    logger.info(
      { totalListings: listings.length, totalOffers: allOffers.length, errors: errors.length },
      'SedoListingProvider: sync complete',
    );

    return {
      marketplace: 'sedo',
      listings,
      offers: allOffers,
      errors,
      syncedAt: new Date().toISOString(),
    };
  }

  // ponytail: sequential page walk shared by getListings/sync. Concurrent
  // page fetches only if Sedo pagination proves slow at scale.
  async #fetchAllListings(): Promise<{ listings: SedoApiListing[]; truncated: boolean }> {
    const all: SedoApiListing[] = [];
    let response = await this.#request<SedoListingsResponse>('/listings?page=1');
    all.push(...response.listings);

    let page = 2;
    while (all.length < response.total && page <= MAX_SYNC_PAGES && response.listings.length > 0) {
      response = await this.#request<SedoListingsResponse>(`/listings?page=${page}`);
      all.push(...response.listings);
      page++;
    }
    const truncated = all.length < response.total;
    if (truncated) {
      logger.warn(
        { fetched: all.length, total: response.total },
        'SedoListingProvider: pagination truncated at page cap',
      );
    }
    return { listings: all, truncated };
  }

  async #request<T>(path: string, options: FetchOptions = {}): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
        ...(options.headers as Record<string, string>),
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        `Sedo API error: ${response.status} ${response.statusText}`,
        'sedo',
        'SEDO_API_ERROR',
        { status: response.status, path, body },
      );
    }

    return response.json() as Promise<T>;
  }

  #requireAuth(): void {
    if (!this.isAvailable) {
      throw new ProviderError(
        'Sedo API key is not configured. Set SEDO_API_KEY in your environment.',
        'sedo',
        'SEDO_API_NOT_CONFIGURED',
      );
    }
  }

  #toInternal(sedo: SedoApiListing): Listing {
    return {
      id: safeRemoteNumericId(sedo.id),
      domain: sedo.domain,
      marketplace: 'sedo' as MarketplaceName,
      externalId: sedo.id,
      listingUrl: sedo.listing_url,
      priceEur: sedo.buy_now_price,
      status: sedoStatusToInternal(sedo.status),
      scoringSnapshotJson: null,
      listedAt: sedo.created_at,
      expiresAt: sedo.expires_at ?? null,
      notes: null,
      createdAt: sedo.created_at,
      updatedAt: sedo.created_at,
    };
  }

  #toInternalOffer(sedo: SedoApiOffer, listingId: number): ListingOffer {
    return {
      id: safeRemoteNumericId(sedo.id),
      listingId,
      amountEur: sedo.amount,
      buyer: sedo.buyer,
      status: sedoOfferStatusToInternal(sedo.status),
      receivedAt: sedo.created_at,
      respondedAt: null,
      notes: null,
    };
  }
}
