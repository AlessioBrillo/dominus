// SPDX-License-Identifier: AGPL-3.0-only
import type { ListingProvider } from '../providers/listing/listing-provider.js';
import type { ListingRepository } from '../db/repositories/listing-repository.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import { GateVerdict, type TrademarkGate } from '../trademark/trademark-gate.js';
import type {
  Listing,
  ListingOffer,
  NewListing,
  ListingUpdate,
  MarketplaceName,
  ListingsFilter,
} from '../types/listing.js';
import { getLogger } from '../logger.js';
import { TrademarkGateError } from '../types/errors.js';

const logger = getLogger();

export class ListingManager {
  readonly #provider: ListingProvider;
  readonly #repo: ListingRepository;
  readonly #engine: ScoringEngine;
  readonly #trademarkGate: TrademarkGate;

  constructor(
    provider: ListingProvider,
    repo: ListingRepository,
    engine: ScoringEngine,
    trademarkGate: TrademarkGate,
  ) {
    this.#provider = provider;
    this.#repo = repo;
    this.#engine = engine;
    this.#trademarkGate = trademarkGate;
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
    const existing = await this.#repo.findByDomainAndMarketplace(domain, marketplace);
    if (existing) {
      logger.warn(
        { domain, marketplace },
        'ListingManager: domain already listed on this marketplace',
      );
      return existing;
    }

    // Trademark gate (Principle 6, ADR-0006): a Blocked domain must never
    // enter the sell pipeline, not even as a local draft. Unverified
    // (sources unreachable) is still tracked as a draft — local-only,
    // no legal exposure — but publish is refused in listOnMarketplace.
    const gate = await this.#trademarkGate.check(domain);
    if (gate.verdict === GateVerdict.Blocked) {
      throw new TrademarkGateError(
        `Refusing to list ${domain}: trademark match on ${gate.matchedMark ?? 'unknown mark'} (${gate.matchSource ?? 'unknown source'})`,
      );
    }
    if (gate.verdict === GateVerdict.Unverified) {
      logger.warn({ domain, marketplace }, 'ListingManager: trademark unverified — draft only');
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

    const { id } = await this.#repo.insert(newListing);
    const listing = await this.#repo.findById(id);
    if (!listing) throw new Error(`Failed to create listing for ${domain}`);

    logger.info({ domain, marketplace, price: finalPrice }, 'ListingManager: listing created');
    return listing;
  }

  async updateListing(id: number, update: ListingUpdate): Promise<Listing> {
    const listing = await this.#repo.findById(id);
    if (!listing) throw new Error(`Listing ${id} not found`);

    // Gate-bypass guard (Principle 6, ADR-0006): 'listed', 'sold' and
    // 'offer_received' are reachable only through listOnMarketplace /
    // recordOffer / respondToOffer, which enforce the trademark gate and
    // offer ownership. A PATCH must never manufacture them.
    if (
      update.status !== undefined &&
      (update.status === 'listed' || update.status === 'sold' || update.status === 'offer_received')
    ) {
      throw new Error(
        `Refusing status transition to '${update.status}': publish via listOnMarketplace, offers via recordOffer/respondToOffer`,
      );
    }

    await this.#repo.update(id, update);

    if (listing.status !== 'draft' && this.#provider.isAvailable) {
      try {
        await this.#provider.updateListing(listing.externalId ?? String(id), update);
      } catch (err) {
        logger.error({ err, listingId: id }, 'ListingManager: failed to update remote listing');
      }
    }

    const updated = await this.#repo.findById(id);
    if (!updated) throw new Error(`Listing ${id} not found after update`);
    return updated;
  }

  async deleteListing(id: number): Promise<void> {
    const listing = await this.#repo.findById(id);
    if (!listing) return;

    if (listing.status === 'listed' && this.#provider.isAvailable) {
      try {
        await this.#provider.cancelListing(listing.externalId ?? String(id));
      } catch (err) {
        logger.error({ err, listingId: id }, 'ListingManager: failed to cancel remote listing');
      }
    }

    await this.#repo.delete(id);
    logger.info({ listingId: id, domain: listing.domain }, 'ListingManager: listing deleted');
  }

  async listOnMarketplace(id: number): Promise<Listing> {
    const listing = await this.#repo.findById(id);
    if (!listing) throw new Error(`Listing ${id} not found`);

    if (listing.status !== 'draft') {
      logger.warn(
        { listingId: id, status: listing.status },
        'ListingManager: listing already published',
      );
      return listing;
    }

    // Re-check at publish time: a match may have appeared after the draft
    // was created, and pre-gate drafts bypassed listDomain entirely.
    // Publishing is the legal-exposure point, so Unverified blocks here.
    const gate = await this.#trademarkGate.check(listing.domain);
    if (gate.verdict !== GateVerdict.Clear) {
      throw new TrademarkGateError(
        `Refusing to publish ${listing.domain}: trademark verdict is ${gate.verdict}`,
      );
    }

    if (!this.#provider.isAvailable) {
      logger.info({ listingId: id }, 'ListingManager: marking as listed (manual mode)');
      await this.#repo.update(id, { status: 'listed' });
      const updated = await this.#repo.findById(id);
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
      // Persist the remote id separately from the local primary key so
      // later update/cancel calls address the remote listing, not a
      // parseInt() collision in the local id space.
      updateFields.externalId = remoteListing.externalId ?? String(remoteListing.id);
      await this.#repo.update(id, updateFields);

      logger.info(
        { listingId: id, domain: listing.domain },
        'ListingManager: listed on marketplace',
      );
    } catch (err) {
      logger.error({ err, listingId: id }, 'ListingManager: failed to list on marketplace');
      await this.#repo.update(id, { status: 'pending' });
    }

    const updated = await this.#repo.findById(id);
    if (!updated) throw new Error(`Listing ${id} not found after publish`);
    return updated;
  }

  async syncAll(): Promise<{ listings: Listing[]; offers: ListingOffer[]; errors: string[] }> {
    if (!this.#provider.isAvailable) {
      const listings = await this.#repo.findAll();
      return { listings, offers: [], errors: [] };
    }

    const result = await this.#provider.sync();
    const allOffers: ListingOffer[] = [];
    const allErrors: string[] = [...result.errors];

    // Remote numeric ids live in the provider's id space, not ours:
    // resolve every remote listing to its local row first, then link
    // offers through the local id. Never persist parseInt(remoteId).
    const remoteExternalId = (remote: { externalId?: string | null; id: number }): string =>
      remote.externalId ?? String(remote.id);
    const localByExternal = new Map<string, Listing>();

    for (const remote of result.listings) {
      const externalId = remoteExternalId(remote);
      const local =
        (await this.#repo.findByMarketplaceAndExternalId(remote.marketplace, externalId)) ??
        (await this.#repo.findByDomainAndMarketplace(remote.domain, remote.marketplace));

      // Trademark gate applies to the local mirror too: a Blocked domain
      // must never be shown as listed/sold, even if the marketplace did.
      const gate = await this.#trademarkGate.check(remote.domain);
      if (gate.verdict === GateVerdict.Blocked) {
        allErrors.push(`${remote.domain}: trademark ${gate.verdict} — not mirrored as listed`);
        if (local && (local.status === 'listed' || local.status === 'offer_received')) {
          await this.#repo.update(local.id, { status: 'unlisted' });
        }
        continue;
      }

      if (local) {
        localByExternal.set(externalId, local);
        const patch: ListingUpdate = {};
        if (local.externalId !== externalId) patch.externalId = externalId;
        if (local.status !== remote.status) patch.status = remote.status;
        if (local.priceEur !== remote.priceEur) patch.priceEur = remote.priceEur;
        if (Object.keys(patch).length > 0) await this.#repo.update(local.id, patch);
      } else {
        const { id } = await this.#repo.insert({
          domain: remote.domain,
          marketplace: remote.marketplace,
          externalId,
          priceEur: remote.priceEur,
          status: remote.status,
          listingUrl: remote.listingUrl,
          listedAt: remote.listedAt,
          expiresAt: remote.expiresAt,
          notes: null,
        });
        const inserted = await this.#repo.findById(id);
        if (inserted) localByExternal.set(externalId, inserted);
      }
    }

    const remoteById = new Map(result.listings.map((r) => [r.id, r] as const));
    for (const remoteOffer of result.offers) {
      const remoteListing = remoteById.get(remoteOffer.listingId);
      const local = remoteListing
        ? localByExternal.get(remoteExternalId(remoteListing))
        : undefined;
      if (!local) {
        allErrors.push(`orphan offer ${remoteOffer.id}: unknown remote listing — skipped`);
        continue;
      }
      const existing = await this.#repo.findPendingOffer(local.id);
      if (!existing || existing.amountEur !== remoteOffer.amountEur) {
        const { id } = await this.#repo.insertOffer({
          listingId: local.id,
          amountEur: remoteOffer.amountEur,
          buyer: remoteOffer.buyer,
          notes: null,
        });
        remoteOffer.id = id;
        remoteOffer.listingId = local.id;

        if (remoteOffer.status === 'pending') {
          await this.#repo.update(local.id, { status: 'offer_received' });
        }
      }
      allOffers.push(remoteOffer);
    }

    const localListings = await this.#repo.findAll();

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
    const listing = await this.#repo.findById(listingId);
    if (!listing) throw new Error(`Listing ${listingId} not found`);

    const { id } = await this.#repo.insertOffer({
      listingId,
      amountEur,
      buyer,
      notes: notes ?? null,
    });
    await this.#repo.update(listingId, { status: 'offer_received' });

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

  async respondToOffer(
    offerId: number,
    listingId: number,
    status: 'accepted' | 'declined',
  ): Promise<void> {
    const offers = await this.#repo.findOffersByListingId(listingId);
    const offer = offers.find((o) => o.id === offerId);
    if (!offer) throw new Error(`Offer ${offerId} not found for listing ${listingId}`);
    if (offer.status !== 'pending') {
      throw new Error(`Offer ${offerId} is not pending (status: ${offer.status})`);
    }
    await this.#repo.updateOfferStatus(offerId, status);
    if (status === 'accepted') {
      await this.#repo.update(listingId, { status: 'sold' });
    }
    logger.info({ offerId, listingId, status }, 'ListingManager: offer response recorded');
  }

  async getListings(filter?: ListingsFilter): Promise<Listing[]> {
    return await this.#repo.findAll(filter);
  }

  async getListing(id: number): Promise<Listing | undefined> {
    return await this.#repo.findById(id);
  }

  async getOffers(listingId: number): Promise<ListingOffer[]> {
    return await this.#repo.findOffersByListingId(listingId);
  }
}
