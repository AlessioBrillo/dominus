import type { Listing, ListingOffer, NewListing, ListingUpdate } from '../../types/listing.js';
import type { ListingProvider, SyncResult } from './listing-provider.js';
import type { ListingRepository } from '../../db/repositories/listing-repository.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

export class ManualListingProvider implements ListingProvider {
  readonly name = 'manual';
  readonly isAvailable = true;

  readonly #repo: ListingRepository;

  constructor(repo: ListingRepository) {
    this.#repo = repo;
  }

  async createListing(newListing: NewListing): Promise<Listing> {
    const { id } = await this.#repo.insert(newListing);
    const listing = await this.#repo.findById(id);
    if (!listing) throw new Error(`Failed to create listing for ${newListing.domain}`);
    logger.info({ domain: newListing.domain }, 'ManualListingProvider: listing created');
    return listing;
  }

  async updateListing(externalId: string, update: ListingUpdate): Promise<Listing> {
    const id = parseInt(externalId, 10);
    await this.#repo.update(id, update);
    const listing = await this.#repo.findById(id);
    if (!listing) throw new Error(`Listing ${externalId} not found`);
    return listing;
  }

  async cancelListing(externalId: string): Promise<void> {
    const id = parseInt(externalId, 10);
    await this.#repo.update(id, { status: 'unlisted' });
    logger.info({ listingId: id }, 'ManualListingProvider: listing cancelled');
  }

  async getListing(externalId: string): Promise<Listing | undefined> {
    const id = parseInt(externalId, 10);
    return await this.#repo.findById(id);
  }

  async getListings(): Promise<Listing[]> {
    return await this.#repo.findAll();
  }

  async getOffers(externalId: string): Promise<ListingOffer[]> {
    const id = parseInt(externalId, 10);
    return await this.#repo.findOffersByListingId(id);
  }

  async sync(): Promise<SyncResult> {
    const listings = await this.#repo.findAll();
    logger.info({ total: listings.length }, 'ManualListingProvider: sync complete');
    return {
      marketplace: 'manual',
      listings,
      offers: [],
      errors: [],
      syncedAt: new Date().toISOString(),
    };
  }
}
