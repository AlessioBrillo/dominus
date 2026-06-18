import type { ListingProvider } from '../providers/listing/listing-provider.js';
import type { ListingRepository } from '../db/repositories/listing-repository.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { TrademarkGate } from '../trademark/trademark-gate.js';
import type {
  Listing,
  ListingOffer,
  NewListing,
  ListingUpdate,
  MarketplaceName,
  ListingsFilter,
} from '../types/listing.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export class ListingManager {
  readonly #provider: ListingProvider;
  readonly #repo: ListingRepository;
  readonly #engine: ScoringEngine;

  constructor(
    provider: ListingProvider,
    repo: ListingRepository,
    engine: ScoringEngine,
    _trademarkGate: TrademarkGate,
  ) {
    this.#provider = provider;
    this.#repo = repo;
    this.#engine = engine;
  }

  get provider(): ListingProvider {
    return this.#provider;
  }

  async listDomain(
    domain: string,
    marketplace: MarketplaceName,
    priceEur?: number,
    options?: { notes?: string },
  ): Promise<Listing> {
    const existing = this.#repo.findByDomainAndMarketplace(domain, marketplace);
    if (existing) {
      logger.warn(
        { domain, marketplace },
        'ListingManager: domain already listed on this marketplace',
      );
      return existing;
    }

    let finalPrice = priceEur;
    if (finalPrice === undefined) {
      const score = await this.#engine.score({ domain, isCloseout: false });
      finalPrice = score.suggestedListPrice;
      logger.info(
        { domain, suggestedPrice: finalPrice },
        'ListingManager: using scoring engine price',
      );
    }

    const newListing: NewListing = {
      domain,
      marketplace,
      priceEur: finalPrice,
      listingUrl: null,
      status: 'draft',
      listedAt: null,
      expiresAt: null,
      notes: options?.notes ?? null,
    };

    const { id } = this.#repo.insert(newListing);
    const listing = this.#repo.findById(id);
    if (!listing) throw new Error(`Failed to create listing for ${domain}`);

    logger.info({ domain, marketplace, price: finalPrice }, 'ListingManager: listing created');
    return listing;
  }

  async updateListing(id: number, update: ListingUpdate): Promise<Listing> {
    const listing = this.#repo.findById(id);
    if (!listing) throw new Error(`Listing ${id} not found`);

    this.#repo.update(id, update);

    if (listing.status !== 'draft' && this.#provider.isAvailable) {
      try {
        await this.#provider.updateListing(String(id), update);
      } catch (err) {
        logger.error({ err, listingId: id }, 'ListingManager: failed to update remote listing');
      }
    }

    const updated = this.#repo.findById(id);
    if (!updated) throw new Error(`Listing ${id} not found after update`);
    return updated;
  }

  async deleteListing(id: number): Promise<void> {
    const listing = this.#repo.findById(id);
    if (!listing) return;

    if (listing.status === 'listed' && this.#provider.isAvailable) {
      try {
        await this.#provider.cancelListing(String(id));
      } catch (err) {
        logger.error({ err, listingId: id }, 'ListingManager: failed to cancel remote listing');
      }
    }

    this.#repo.delete(id);
    logger.info({ listingId: id, domain: listing.domain }, 'ListingManager: listing deleted');
  }

  async listOnMarketplace(id: number): Promise<Listing> {
    const listing = this.#repo.findById(id);
    if (!listing) throw new Error(`Listing ${id} not found`);

    if (listing.status !== 'draft') {
      logger.warn(
        { listingId: id, status: listing.status },
        'ListingManager: listing already published',
      );
      return listing;
    }

    if (!this.#provider.isAvailable) {
      logger.info({ listingId: id }, 'ListingManager: marking as listed (manual mode)');
      this.#repo.update(id, { status: 'listed' });
      const updated = this.#repo.findById(id);
      if (!updated) throw new Error(`Listing ${id} not found after publish`);
      return updated;
    }

    try {
      const remoteListing = await this.#provider.createListing({
        domain: listing.domain,
        marketplace: listing.marketplace,
        priceEur: listing.priceEur,
        listingUrl: null,
        status: 'listed',
        listedAt: null,
        expiresAt: null,
        notes: null,
      });

      const updateFields: ListingUpdate = { status: 'listed' };
      if (remoteListing.listingUrl !== null) {
        updateFields.listingUrl = remoteListing.listingUrl;
      }
      this.#repo.update(id, updateFields);

      logger.info(
        { listingId: id, domain: listing.domain },
        'ListingManager: listed on marketplace',
      );
    } catch (err) {
      logger.error({ err, listingId: id }, 'ListingManager: failed to list on marketplace');
      this.#repo.update(id, { status: 'pending' });
    }

    const updated = this.#repo.findById(id);
    if (!updated) throw new Error(`Listing ${id} not found after publish`);
    return updated;
  }

  async syncAll(): Promise<{ listings: Listing[]; offers: ListingOffer[]; errors: string[] }> {
    if (!this.#provider.isAvailable) {
      const listings = this.#repo.findAll();
      return { listings, offers: [], errors: [] };
    }

    const result = await this.#provider.sync();
    const allOffers: ListingOffer[] = [];
    const allErrors: string[] = [...result.errors];

    for (const remote of result.listings) {
      const local = this.#repo.findByDomainAndMarketplace(remote.domain, remote.marketplace);
      if (local) {
        if (local.status !== remote.status || local.priceEur !== remote.priceEur) {
          this.#repo.update(local.id, {
            status: remote.status,
            priceEur: remote.priceEur,
          });
        }
      } else {
        this.#repo.insert({
          domain: remote.domain,
          marketplace: remote.marketplace,
          priceEur: remote.priceEur,
          status: remote.status,
          listingUrl: remote.listingUrl,
          listedAt: remote.listedAt,
          expiresAt: remote.expiresAt,
          notes: null,
        });
      }
    }

    for (const remoteOffer of result.offers) {
      const existing = this.#repo.findPendingOffer(remoteOffer.listingId);
      if (!existing || existing.amountEur !== remoteOffer.amountEur) {
        const { id } = this.#repo.insertOffer({
          listingId: remoteOffer.listingId,
          amountEur: remoteOffer.amountEur,
          buyer: remoteOffer.buyer,
          notes: null,
        });
        remoteOffer.id = id;

        if (remoteOffer.status === 'pending') {
          this.#repo.update(remoteOffer.listingId, { status: 'offer_received' });
        }
      }
      allOffers.push(remoteOffer);
    }

    const localListings = this.#repo.findAll();

    logger.info(
      { listings: localListings.length, offers: allOffers.length, errors: allErrors.length },
      'ListingManager: sync complete',
    );

    return { listings: localListings, offers: allOffers, errors: allErrors };
  }

  async recordOffer(
    listingId: number,
    amountEur: number,
    buyer: string,
    notes?: string,
  ): Promise<ListingOffer> {
    const listing = this.#repo.findById(listingId);
    if (!listing) throw new Error(`Listing ${listingId} not found`);

    const { id } = this.#repo.insertOffer({ listingId, amountEur, buyer, notes: notes ?? null });
    this.#repo.update(listingId, { status: 'offer_received' });

    const offer: ListingOffer = {
      id,
      listingId,
      amountEur,
      buyer,
      status: 'pending',
      receivedAt: new Date().toISOString(),
      respondedAt: null,
      notes: notes ?? null,
    };

    logger.info({ listingId, amountEur, buyer }, 'ListingManager: offer recorded');
    return offer;
  }

  respondToOffer(offerId: number, listingId: number, status: 'accepted' | 'declined'): void {
    this.#repo.updateOfferStatus(offerId, status);
    if (status === 'accepted') {
      this.#repo.update(listingId, { status: 'sold' });
    }
    logger.info({ offerId, listingId, status }, 'ListingManager: offer response recorded');
  }

  getListings(filter?: ListingsFilter): Listing[] {
    return this.#repo.findAll(filter);
  }

  getListing(id: number): Listing | undefined {
    return this.#repo.findById(id);
  }

  getOffers(listingId: number): ListingOffer[] {
    return this.#repo.findOffersByListingId(listingId);
  }
}
