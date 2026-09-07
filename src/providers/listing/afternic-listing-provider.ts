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

interface AfternicApiListing {
  id: string;
  domain: string;
  buy_now_price: number;
  status: 'active' | 'sold' | 'expired' | 'paused' | 'pending' | 'inactive';
  listing_url: string;
  created_at: string;
  expires_at: string | null;
}

interface AfternicApiOffer {
  id: string;
  amount: number;
  buyer: string;
  status: 'pending' | 'accepted' | 'declined' | 'countered' | 'withdrawn';
  created_at: string;
}

interface AfternicListingsResponse {
  listings: AfternicApiListing[];
  total: number;
  page: number;
}

interface AfternicCreateListingPayload {
  domain: string;
  buy_now_price: number;
  listing_type?: 'buy_it_now' | 'lease_to_own';
}

export const AFTERNIC_API_BASE = 'https://api.afternic.com/v1';

function afternicStatusToInternal(status: AfternicApiListing['status']): ListingStatus {
  const map: Record<AfternicApiListing['status'], ListingStatus> = {
    active: 'listed',
    sold: 'sold',
    expired: 'expired',
    paused: 'paused',
    pending: 'pending',
    inactive: 'unlisted',
  };
  return map[status] ?? 'draft';
}

function internalStatusToAfternic(status: ListingStatus): AfternicApiListing['status'] | undefined {
  const map: Record<string, AfternicApiListing['status']> = {
    listed: 'active',
    sold: 'sold',
    expired: 'expired',
    paused: 'paused',
    pending: 'pending',
    unlisted: 'inactive',
  };
  return map[status];
}

function afternicOfferStatusToInternal(status: AfternicApiOffer['status']): OfferStatus {
  const map: Record<AfternicApiOffer['status'], OfferStatus> = {
    pending: 'pending',
    accepted: 'accepted',
    declined: 'declined',
    countered: 'countered',
    withdrawn: 'withdrawn',
  };
  return map[status] ?? 'pending';
}

export class AfternicListingProvider implements ListingProvider {
  readonly name = 'afternic';
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(apiKey: string | undefined, baseUrl: string = AFTERNIC_API_BASE) {
    if (!apiKey) {
      logger.warn('AfternicListingProvider: no API key provided — provider is unavailable');
    }
    this.#apiKey = apiKey ?? '';
    this.#baseUrl = baseUrl;
  }

  get isAvailable(): boolean {
    return this.#apiKey.length > 0;
  }

  async createListing(newListing: NewListing): Promise<Listing> {
    this.#requireAuth();

    const payload: AfternicCreateListingPayload = {
      domain: newListing.domain,
      buy_now_price: newListing.priceEur,
    };

    const response = await this.#request<AfternicApiListing>('/listings', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    logger.info(
      { domain: newListing.domain, afternicId: response.id },
      'AfternicListingProvider: listing created',
    );
    return this.#toInternal(response);
  }

  async updateListing(externalId: string, update: ListingUpdate): Promise<Listing> {
    this.#requireAuth();

    const body: Record<string, unknown> = {};
    if (update.priceEur !== undefined) body['buy_now_price'] = update.priceEur;
    if (update.status !== undefined) {
      const afternicStatus = internalStatusToAfternic(update.status);
      if (afternicStatus) body['status'] = afternicStatus;
    }

    const response = await this.#request<AfternicApiListing>(`/listings/${externalId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    return this.#toInternal(response);
  }

  async cancelListing(externalId: string): Promise<void> {
    this.#requireAuth();
    await this.#request(`/listings/${externalId}`, { method: 'DELETE' });
    logger.info({ afternicId: externalId }, 'AfternicListingProvider: listing cancelled');
  }

  async getListing(externalId: string): Promise<Listing | undefined> {
    this.#requireAuth();
    try {
      const response = await this.#request<AfternicApiListing>(`/listings/${externalId}`);
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
    const offers = await this.#request<AfternicApiOffer[]>(`/listings/${externalId}/offers`);
    return offers.map((o) => this.#toInternalOffer(o, safeRemoteNumericId(externalId)));
  }

  async sync(): Promise<SyncResult> {
    const errors: string[] = [];

    if (!this.isAvailable) {
      return {
        marketplace: 'afternic',
        listings: [],
        offers: [],
        errors: ['Afternic API key not configured'],
        syncedAt: new Date().toISOString(),
      };
    }

    // ponytail: naive page-at-a-time pagination with page size derived from
    // the first response. If Afternic API performance degrades at scale,
    // replace with concurrent page fetches.
    let allAfternicListings: AfternicApiListing[];
    try {
      allAfternicListings = await this.#fetchAllListings();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'AfternicListingProvider: sync failed');
      return {
        marketplace: 'afternic',
        listings: [],
        offers: [],
        errors: [msg],
        syncedAt: new Date().toISOString(),
      };
    }

    const listings: Listing[] = [];
    const allOffers: ListingOffer[] = [];

    for (const al of allAfternicListings) {
      try {
        const listing = this.#toInternal(al);
        listings.push(listing);

        const offers = await this.#request<AfternicApiOffer[]>(`/listings/${al.id}/offers`);
        allOffers.push(...offers.map((o) => this.#toInternalOffer(o, safeRemoteNumericId(al.id))));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${al.domain}: ${msg}`);
      }
    }

    logger.info(
      { totalListings: listings.length, totalOffers: allOffers.length, errors: errors.length },
      'AfternicListingProvider: sync complete',
    );

    return {
      marketplace: 'afternic',
      listings,
      offers: allOffers,
      errors,
      syncedAt: new Date().toISOString(),
    };
  }

  // ponytail: sequential page walk shared by getListings/sync. Concurrent
  // page fetches only if Afternic pagination proves slow at scale.
  async #fetchAllListings(): Promise<AfternicApiListing[]> {
    const all: AfternicApiListing[] = [];
    let response = await this.#request<AfternicListingsResponse>('/listings?page=1');
    all.push(...response.listings);

    let page = 2;
    while (all.length < response.total && page <= MAX_SYNC_PAGES && response.listings.length > 0) {
      response = await this.#request<AfternicListingsResponse>(`/listings?page=${page}`);
      all.push(...response.listings);
      page++;
    }
    if (all.length < response.total) {
      logger.warn(
        { fetched: all.length, total: response.total },
        'AfternicListingProvider: pagination truncated at page cap',
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
        `Afternic API error: ${response.status} ${response.statusText}`,
        'afternic',
        'AFTERNIC_API_ERROR',
        { status: response.status, path, body },
      );
    }

    return response.json() as Promise<T>;
  }

  #requireAuth(): void {
    if (!this.isAvailable) {
      throw new ProviderError(
        'Afternic API key is not configured. Set AFTERNIC_API_KEY in your environment.',
        'afternic',
        'AFTERNIC_API_NOT_CONFIGURED',
      );
    }
  }

  #toInternal(afternic: AfternicApiListing): Listing {
    return {
      id: safeRemoteNumericId(afternic.id),
      domain: afternic.domain,
      marketplace: 'afternic' as MarketplaceName,
      externalId: afternic.id,
      listingUrl: afternic.listing_url,
      priceEur: afternic.buy_now_price,
      status: afternicStatusToInternal(afternic.status),
      scoringSnapshotJson: null,
      listedAt: afternic.created_at,
      expiresAt: afternic.expires_at ?? null,
      notes: null,
      createdAt: afternic.created_at,
      updatedAt: afternic.created_at,
    };
  }

  #toInternalOffer(afternic: AfternicApiOffer, listingId: number): ListingOffer {
    return {
      id: safeRemoteNumericId(afternic.id),
      listingId,
      amountEur: afternic.amount,
      buyer: afternic.buyer,
      status: afternicOfferStatusToInternal(afternic.status),
      receivedAt: afternic.created_at,
      respondedAt: null,
      notes: null,
    };
  }
}
