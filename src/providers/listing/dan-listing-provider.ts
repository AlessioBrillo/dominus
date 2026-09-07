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

interface DanApiListing {
  id: string;
  domain: string;
  buy_now_price: number;
  status: 'active' | 'sold' | 'expired' | 'paused' | 'pending' | 'inactive';
  listing_url: string;
  created_at: string;
  expires_at: string | null;
}

interface DanApiOffer {
  id: string;
  amount: number;
  buyer: string;
  status: 'pending' | 'accepted' | 'declined' | 'countered' | 'withdrawn';
  created_at: string;
}

interface DanListingsResponse {
  listings: DanApiListing[];
  total: number;
  page: number;
}

interface DanCreateListingPayload {
  domain: string;
  buy_now_price: number;
  listing_type?: 'buy_it_now' | 'lease_to_own';
}

const DAN_API_BASE = 'https://api.dan.com/v1';

function danStatusToInternal(status: DanApiListing['status']): ListingStatus {
  const map: Record<DanApiListing['status'], ListingStatus> = {
    active: 'listed',
    sold: 'sold',
    expired: 'expired',
    paused: 'paused',
    pending: 'pending',
    inactive: 'unlisted',
  };
  return map[status] ?? 'draft';
}

function internalStatusToDan(status: ListingStatus): DanApiListing['status'] | undefined {
  const map: Record<string, DanApiListing['status']> = {
    listed: 'active',
    sold: 'sold',
    expired: 'expired',
    paused: 'paused',
    pending: 'pending',
    unlisted: 'inactive',
  };
  return map[status];
}

function danOfferStatusToInternal(status: DanApiOffer['status']): OfferStatus {
  const map: Record<DanApiOffer['status'], OfferStatus> = {
    pending: 'pending',
    accepted: 'accepted',
    declined: 'declined',
    countered: 'countered',
    withdrawn: 'withdrawn',
  };
  return map[status] ?? 'pending';
}

export class DanListingProvider implements ListingProvider {
  readonly name = 'dan';
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(apiKey: string | undefined, baseUrl: string = DAN_API_BASE) {
    if (!apiKey) {
      logger.warn('DanListingProvider: no API key provided — provider is unavailable');
    }
    this.#apiKey = apiKey ?? '';
    this.#baseUrl = baseUrl;
  }

  get isAvailable(): boolean {
    return this.#apiKey.length > 0;
  }

  async createListing(newListing: NewListing): Promise<Listing> {
    this.#requireAuth();

    const payload: DanCreateListingPayload = {
      domain: newListing.domain,
      buy_now_price: newListing.priceEur,
    };

    const response = await this.#request<DanApiListing>('/listings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    logger.info(
      { domain: newListing.domain, danId: response.id },
      'DanListingProvider: listing created',
    );
    return this.#toInternal(response);
  }

  async updateListing(externalId: string, update: ListingUpdate): Promise<Listing> {
    this.#requireAuth();

    const body: Record<string, unknown> = {};
    if (update.priceEur !== undefined) body['buy_now_price'] = update.priceEur;
    if (update.status !== undefined) {
      const danStatus = internalStatusToDan(update.status);
      if (danStatus) body['status'] = danStatus;
    }

    const response = await this.#request<DanApiListing>(`/listings/${externalId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    return this.#toInternal(response);
  }

  async cancelListing(externalId: string): Promise<void> {
    this.#requireAuth();
    await this.#request(`/listings/${externalId}`, { method: 'DELETE' });
    logger.info({ danId: externalId }, 'DanListingProvider: listing cancelled');
  }

  async getListing(externalId: string): Promise<Listing | undefined> {
    this.#requireAuth();
    try {
      const response = await this.#request<DanApiListing>(`/listings/${externalId}`);
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
    return (await this.#fetchAllListings()).map((l) => this.#toInternal(l));
  }

  async getOffers(externalId: string): Promise<ListingOffer[]> {
    this.#requireAuth();
    const offers = await this.#request<DanApiOffer[]>(`/listings/${externalId}/offers`);
    return offers.map((o) => this.#toInternalOffer(o, safeRemoteNumericId(externalId)));
  }

  async sync(): Promise<SyncResult> {
    const errors: string[] = [];

    if (!this.isAvailable) {
      return {
        marketplace: 'dan',
        listings: [],
        offers: [],
        errors: ['Dan.com API key not configured'],
        syncedAt: new Date().toISOString(),
      };
    }

    // ponytail: naive page-at-a-time pagination with page size derived from
    // the first response. If Dan API performance degrades at scale, replace
    // with concurrent page fetches.
    let allDanListings: DanApiListing[];
    try {
      allDanListings = await this.#fetchAllListings();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'DanListingProvider: sync failed');
      return {
        marketplace: 'dan',
        listings: [],
        offers: [],
        errors: [msg],
        syncedAt: new Date().toISOString(),
      };
    }

    const listings: Listing[] = [];
    const allOffers: ListingOffer[] = [];

    for (const dl of allDanListings) {
      try {
        const listing = this.#toInternal(dl);
        listings.push(listing);

        const offers = await this.#request<DanApiOffer[]>(`/listings/${dl.id}/offers`);
        allOffers.push(...offers.map((o) => this.#toInternalOffer(o, safeRemoteNumericId(dl.id))));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${dl.domain}: ${msg}`);
      }
    }

    logger.info(
      { totalListings: listings.length, totalOffers: allOffers.length, errors: errors.length },
      'DanListingProvider: sync complete',
    );

    return {
      marketplace: 'dan',
      listings,
      offers: allOffers,
      errors,
      syncedAt: new Date().toISOString(),
    };
  }

  // ponytail: sequential page walk shared by getListings/sync. Concurrent
  // page fetches only if Dan pagination proves slow at scale.
  async #fetchAllListings(): Promise<DanApiListing[]> {
    const all: DanApiListing[] = [];
    let response = await this.#request<DanListingsResponse>('/listings?page=1');
    all.push(...response.listings);

    let page = 2;
    while (all.length < response.total && page <= MAX_SYNC_PAGES && response.listings.length > 0) {
      response = await this.#request<DanListingsResponse>(`/listings?page=${page}`);
      all.push(...response.listings);
      page++;
    }
    if (all.length < response.total) {
      logger.warn(
        { fetched: all.length, total: response.total },
        'DanListingProvider: pagination truncated at page cap',
      );
    }
    return all;
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
        `Dan.com API error: ${response.status} ${response.statusText}`,
        'dan',
        'DAN_API_ERROR',
        { status: response.status, path, body },
      );
    }

    return response.json() as Promise<T>;
  }

  #requireAuth(): void {
    if (!this.isAvailable) {
      throw new ProviderError(
        'Dan.com API key is not configured. Set DAN_API_KEY in your environment.',
        'dan',
        'DAN_API_NOT_CONFIGURED',
      );
    }
  }

  #toInternal(dan: DanApiListing): Listing {
    return {
      id: safeRemoteNumericId(dan.id),
      domain: dan.domain,
      marketplace: 'dan' as MarketplaceName,
      externalId: dan.id,
      listingUrl: dan.listing_url,
      priceEur: dan.buy_now_price,
      status: danStatusToInternal(dan.status),
      scoringSnapshotJson: null,
      listedAt: dan.created_at,
      expiresAt: dan.expires_at ?? null,
      notes: null,
      createdAt: dan.created_at,
      updatedAt: dan.created_at,
    };
  }

  #toInternalOffer(dan: DanApiOffer, listingId: number): ListingOffer {
    return {
      id: safeRemoteNumericId(dan.id),
      listingId,
      amountEur: dan.amount,
      buyer: dan.buyer,
      status: danOfferStatusToInternal(dan.status),
      receivedAt: dan.created_at,
      respondedAt: null,
      notes: null,
    };
  }
}
