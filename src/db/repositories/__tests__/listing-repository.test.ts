import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { ListingRepository } from '../listing-repository.js';
import type { NewListing, NewListingOffer } from '../../../types/listing.js';

function createTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      marketplace TEXT NOT NULL,
      listing_url TEXT,
      price_eur REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      scoring_snapshot_json TEXT,
      listed_at TEXT,
      expires_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_domain_marketplace ON listings(domain, marketplace);
    CREATE TABLE IF NOT EXISTS listing_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
      amount_eur REAL NOT NULL,
      buyer TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      responded_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return provider;
}

describe('ListingRepository', () => {
  let provider: SqliteProvider;
  let repo: ListingRepository;

  const sampleListing: NewListing = {
    domain: 'example.com',
    marketplace: 'manual' as const,
    priceEur: 1500,
    listingUrl: null,
    status: 'draft',
    listedAt: null,
    expiresAt: null,
    notes: null,
  };

  const sampleListing2: NewListing = {
    domain: 'test.io',
    marketplace: 'dan' as const,
    priceEur: 3000,
    listingUrl: null,
    status: 'listed',
    listedAt: new Date().toISOString(),
    expiresAt: null,
    notes: null,
  };

  beforeEach(() => {
    provider = createTestDb();
    repo = new ListingRepository(provider);
  });

  it('inserts and retrieves a listing by id', async () => {
    const { id } = await repo.insert(sampleListing);
    const found = await repo.findById(id);
    expect(found).toBeDefined();
    expect(found!.domain).toBe('example.com');
    expect(found!.priceEur).toBe(1500);
  });

  it('finds listings by domain', async () => {
    await repo.insert(sampleListing);
    await repo.insert(sampleListing2);

    const results = await repo.findByDomain('example.com');
    expect(results).toHaveLength(1);
    expect(results[0]!.marketplace).toBe('manual');
  });

  it('finds listings by domain and marketplace', async () => {
    await repo.insert(sampleListing);
    await repo.insert(sampleListing2);

    const found = await repo.findByDomainAndMarketplace('example.com', 'manual');
    expect(found).toBeDefined();
    expect(found!.priceEur).toBe(1500);
  });

  it('returns undefined for unknown domain and marketplace combo', async () => {
    const found = await repo.findByDomainAndMarketplace('unknown.com', 'manual');
    expect(found).toBeUndefined();
  });

  it('updates a listing partially', async () => {
    const { id } = await repo.insert(sampleListing);
    await repo.update(id, { priceEur: 2000, status: 'listed' });

    const updated = await repo.findById(id);
    expect(updated!.priceEur).toBe(2000);
    expect(updated!.status).toBe('listed');
  });

  it('deletes a listing', async () => {
    const { id } = await repo.insert(sampleListing);
    await repo.delete(id);
    expect(await repo.findById(id)).toBeUndefined();
  });

  it('lists all listings', async () => {
    await repo.insert(sampleListing);
    await repo.insert(sampleListing2);

    const all = await repo.findAll();
    expect(all).toHaveLength(2);
  });

  it('filters listings by status', async () => {
    await repo.insert(sampleListing);
    await repo.insert(sampleListing2);

    const draftListings = await repo.findByStatus('draft');
    expect(draftListings).toHaveLength(1);
    expect(draftListings[0]!.domain).toBe('example.com');
  });

  it('inserts and retrieves offers for a listing', async () => {
    const { id: listingId } = await repo.insert(sampleListing);

    const offer: NewListingOffer = {
      listingId,
      amountEur: 800,
      buyer: 'Buyer123',
      notes: null,
    };
    await repo.insertOffer(offer);

    const offers = await repo.findOffersByListingId(listingId);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.amountEur).toBe(800);
    expect(offers[0]!.buyer).toBe('Buyer123');
  });

  it('finds pending offer for a listing', async () => {
    const { id: listingId } = await repo.insert(sampleListing);

    await repo.insertOffer({ listingId, amountEur: 500, buyer: 'Buyer1', notes: null });
    await repo.insertOffer({ listingId, amountEur: 700, buyer: 'Buyer2', notes: null });

    const pending = await repo.findPendingOffer(listingId);
    expect(pending).toBeDefined();
    expect(pending!.amountEur).toBe(500);
  });

  it('updates offer status', async () => {
    const { id: listingId } = await repo.insert(sampleListing);
    const { id: offerId } = await repo.insertOffer({
      listingId,
      amountEur: 800,
      buyer: 'Buyer123',
      notes: null,
    });

    await repo.updateOfferStatus(offerId, 'accepted');
    const offers = await repo.findOffersByListingId(listingId);
    expect(offers[0]!.status).toBe('accepted');
  });
});
