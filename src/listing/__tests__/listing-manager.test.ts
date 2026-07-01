import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { ListingRepository } from '../../db/repositories/listing-repository.js';
import { ManualListingProvider } from '../../providers/listing/manual-listing-provider.js';
import { ListingManager } from '../listing-manager.js';
import type { ListingProvider } from '../../providers/listing/listing-provider.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';

function createTestDb(): { db: Database.Database; dbProvider: SqliteProvider } {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      marketplace TEXT NOT NULL,
      listing_url TEXT,
      price_eur REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      tenant_id TEXT NOT NULL DEFAULT 'default',
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
  const dbProvider = new SqliteProvider(db);
  return { db, dbProvider };
}

function createMockEngine(): ScoringEngine {
  return {
    score: vi.fn().mockResolvedValue({
      domain: 'example.com',
      expectedValue: 800,
      confidence: 0.65,
      suggestedBuyMax: 350,
      suggestedListPrice: 2000,
      weightedScore: 0.72,
      breakdown: {} as never,
      recommended: true,
      scoredAt: new Date().toISOString(),
      signalStatus: [],
      effectiveWeights: { intrinsic: 0.3, commercial: 0.3, market: 0.2, expiry: 0.2 },
      effectiveRecommendThreshold: 0.4,
      effectiveConfidenceThreshold: 0.3,
      bidRange: { conservative: 200, aggressive: 350 },
    }),
    updateWeights: vi.fn(),
    updateTldBonuses: vi.fn(),
    get currentWeights() {
      return { intrinsic: 0.3, commercial: 0.3, market: 0.2, expiry: 0.2 };
    },
  } as unknown as ScoringEngine;
}

function createMockGate(): TrademarkGate {
  return {
    check: vi.fn().mockResolvedValue({ status: 'clear', match: null }),
  } as unknown as TrademarkGate;
}

describe('ListingManager', () => {
  it('creates a listing for a domain', async () => {
    const { dbProvider } = createTestDb();
    const repo = new ListingRepository(dbProvider);
    const provider: ListingProvider = new ManualListingProvider(repo);
    const engine = createMockEngine();
    const gate = createMockGate();

    const manager = new ListingManager(provider, repo, engine, gate);
    const listing = await manager.listDomain('example.com', 'manual', 1500);

    expect(listing.domain).toBe('example.com');
    expect(listing.marketplace).toBe('manual');
    expect(listing.priceEur).toBe(1500);
    expect(listing.status).toBe('draft');
    expect(listing.id).toBeGreaterThan(0);
  });

  it('creates a listing with auto-priced from scoring engine', async () => {
    const { dbProvider } = createTestDb();
    const repo = new ListingRepository(dbProvider);
    const provider: ListingProvider = new ManualListingProvider(repo);
    const engine = createMockEngine();
    const gate = createMockGate();

    const manager = new ListingManager(provider, repo, engine, gate);
    const listing = await manager.listDomain('example.com', 'dan');

    expect(listing.priceEur).toBe(2000);
    expect(engine.score).toHaveBeenCalledWith({ domain: 'example.com', isCloseout: false });
  });

  it('returns existing listing when re-listing same domain+marketplace', async () => {
    const { dbProvider } = createTestDb();
    const repo = new ListingRepository(dbProvider);
    const provider: ListingProvider = new ManualListingProvider(repo);
    const engine = createMockEngine();
    const gate = createMockGate();

    const manager = new ListingManager(provider, repo, engine, gate);
    const first = await manager.listDomain('example.com', 'manual', 1000);
    const second = await manager.listDomain('example.com', 'manual', 2000);

    expect(second.id).toBe(first.id);
    expect(second.priceEur).toBe(1000);
  });

  it('updates a listing price and status', async () => {
    const { dbProvider } = createTestDb();
    const repo = new ListingRepository(dbProvider);
    const provider: ListingProvider = new ManualListingProvider(repo);
    const engine = createMockEngine();
    const gate = createMockGate();

    const manager = new ListingManager(provider, repo, engine, gate);
    const listing = await manager.listDomain('example.com', 'manual', 1000);

    const updated = await manager.updateListing(listing.id, { priceEur: 1200, status: 'listed' });
    expect(updated.priceEur).toBe(1200);
    expect(updated.status).toBe('listed');
  });

  it('deletes a listing', async () => {
    const { dbProvider } = createTestDb();
    const repo = new ListingRepository(dbProvider);
    const provider: ListingProvider = new ManualListingProvider(repo);
    const engine = createMockEngine();
    const gate = createMockGate();

    const manager = new ListingManager(provider, repo, engine, gate);
    const listing = await manager.listDomain('example.com', 'manual', 1000);

    await manager.deleteListing(listing.id);
    expect(await manager.getListing(listing.id)).toBeUndefined();
  });

  it('records an offer and updates listing status', async () => {
    const { dbProvider } = createTestDb();
    const repo = new ListingRepository(dbProvider);
    const provider: ListingProvider = new ManualListingProvider(repo);
    const engine = createMockEngine();
    const gate = createMockGate();

    const manager = new ListingManager(provider, repo, engine, gate);
    const listing = await manager.listDomain('example.com', 'manual', 1000);

    const offer = await manager.recordOffer(listing.id, 800, 'Buyer123');
    expect(offer.amountEur).toBe(800);
    expect(offer.buyer).toBe('Buyer123');
    expect(offer.status).toBe('pending');

    const updatedListing = await manager.getListing(listing.id);
    expect(updatedListing?.status).toBe('offer_received');
  });

  it('accepts an offer and marks listing as sold', async () => {
    const { dbProvider } = createTestDb();
    const repo = new ListingRepository(dbProvider);
    const provider: ListingProvider = new ManualListingProvider(repo);
    const engine = createMockEngine();
    const gate = createMockGate();

    const manager = new ListingManager(provider, repo, engine, gate);
    const listing = await manager.listDomain('example.com', 'manual', 1000);
    const offer = await manager.recordOffer(listing.id, 800, 'Buyer123');

    await manager.respondToOffer(offer.id, listing.id, 'accepted');
    const updatedListing = await manager.getListing(listing.id);
    expect(updatedListing?.status).toBe('sold');

    const offers = await manager.getOffers(listing.id);
    expect(offers[0]?.status).toBe('accepted');
  });

  it('declines an offer', async () => {
    const { dbProvider } = createTestDb();
    const repo = new ListingRepository(dbProvider);
    const provider: ListingProvider = new ManualListingProvider(repo);
    const engine = createMockEngine();
    const gate = createMockGate();

    const manager = new ListingManager(provider, repo, engine, gate);
    const listing = await manager.listDomain('example.com', 'manual', 1000);
    const offer = await manager.recordOffer(listing.id, 500, 'Lowballer');

    await manager.respondToOffer(offer.id, listing.id, 'declined');
    const offers = await manager.getOffers(listing.id);
    expect(offers[0]?.status).toBe('declined');
    expect((await manager.getListing(listing.id))?.status).toBe('offer_received');
  });

  it('lists all listings with optional filter', async () => {
    const { dbProvider } = createTestDb();
    const repo = new ListingRepository(dbProvider);
    const provider: ListingProvider = new ManualListingProvider(repo);
    const engine = createMockEngine();
    const gate = createMockGate();

    const manager = new ListingManager(provider, repo, engine, gate);
    await manager.listDomain('alpha.com', 'manual', 500);
    await manager.listDomain('beta.com', 'dan', 1000);

    const all = await manager.getListings();
    expect(all.length).toBe(2);

    const dan = await manager.getListings({ marketplace: 'dan' });
    expect(dan.length).toBe(1);
  });
});
