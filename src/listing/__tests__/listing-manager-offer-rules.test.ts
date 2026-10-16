// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { ListingRepository } from '../../db/repositories/listing-repository.js';
import { TenantListingSettingsRepository } from '../../db/repositories/tenant-listing-settings-repository.js';
import { ManualListingProvider } from '../../providers/listing/manual-listing-provider.js';
import { ListingManager } from '../listing-manager.js';
import { up as createListingSettingsTable } from '../../db/migrations/0065_create_tenant_listing_settings.js';
import type { ListingProvider } from '../../providers/listing/listing-provider.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import { GateVerdict } from '../../trademark/trademark-gate.js';

/** Listings schema (as in the migration tests) plus migration 0065. */
function createTestDb(): SqliteProvider {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      marketplace TEXT NOT NULL,
      external_id TEXT,
      listing_url TEXT,
      price_eur REAL NOT NULL,
      list_price_eur REAL,
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
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  createListingSettingsTable(db);
  return new SqliteProvider(db);
}

function mockEngine(): ScoringEngine {
  return {
    score: vi.fn().mockResolvedValue({
      domain: 'example.com',
      expectedValue: 800,
      confidence: 0.65,
      suggestedBuyMax: 350,
      suggestedListPrice: 2000,
      weightedScore: 0.72,
      breakdown: {},
      recommended: true,
      scoredAt: new Date().toISOString(),
      signalStatus: [],
      effectiveWeights: { intrinsic: 0.3, commercial: 0.3, market: 0.2, expiry: 0.2 },
      effectiveRecommendThreshold: 0.4,
      effectiveConfidenceThreshold: 0.3,
      bidRange: { conservative: 200, aggressive: 350 },
    }),
  } as unknown as ScoringEngine;
}

function mockGate(): TrademarkGate {
  return {
    check: vi.fn().mockResolvedValue({ domain: 'example.com', verdict: GateVerdict.Clear }),
  } as unknown as TrademarkGate;
}

function buildManager(): {
  manager: ListingManager;
  settingsRepo: TenantListingSettingsRepository;
} {
  const provider = createTestDb();
  const repo = new ListingRepository(provider);
  const settingsRepo = new TenantListingSettingsRepository(provider);
  const listingProvider: ListingProvider = new ManualListingProvider(repo);
  const manager = new ListingManager(listingProvider, repo, mockEngine(), mockGate(), settingsRepo);
  return { manager, settingsRepo };
}

describe('ListingManager offer rules (M4)', () => {
  it('leaves offers pending when no rule is configured (conservative default)', async () => {
    const { manager } = buildManager();
    const listing = await manager.listDomain('example.com', 'manual', 1000);

    const offer = await manager.recordOffer(listing.id, 5, 'Lowballer');

    expect(offer.status).toBe('pending');
    expect((await manager.getListing(listing.id))?.status).toBe('offer_received');
    const stored = await manager.getOffers(listing.id);
    expect(stored[0]?.status).toBe('pending');
  });

  it('auto-declines offers below the tenant floor and reverts the listing', async () => {
    const { manager, settingsRepo } = buildManager();
    await settingsRepo.set({ offerAutoDeclineBelowEur: 100 });
    const listing = await manager.listDomain('example.com', 'manual', 1000);

    const offer = await manager.recordOffer(listing.id, 50, 'Lowballer');

    expect(offer.status).toBe('declined');
    expect(offer.notes).toContain('Auto-declined');
    expect((await manager.getListing(listing.id))?.status).toBe('listed');
    const stored = await manager.getOffers(listing.id);
    expect(stored[0]?.status).toBe('declined');
  });

  it('counters offers below the tenant counter price', async () => {
    const { manager, settingsRepo } = buildManager();
    await settingsRepo.set({ offerAutoDeclineBelowEur: 100, offerCounterEur: 800 });
    const listing = await manager.listDomain('example.com', 'manual', 1000);

    const offer = await manager.recordOffer(listing.id, 500, 'Haggler');

    expect(offer.status).toBe('countered');
    expect(offer.notes).toContain('800');
    expect((await manager.getListing(listing.id))?.status).toBe('listed');
  });

  it('keeps offers above the floor pending for a human decision', async () => {
    const { manager, settingsRepo } = buildManager();
    await settingsRepo.set({ offerAutoDeclineBelowEur: 100, offerCounterEur: 800 });
    const listing = await manager.listDomain('example.com', 'manual', 1000);

    const offer = await manager.recordOffer(listing.id, 900, 'SeriousBuyer');

    expect(offer.status).toBe('pending');
    expect((await manager.getListing(listing.id))?.status).toBe('offer_received');
  });
});
