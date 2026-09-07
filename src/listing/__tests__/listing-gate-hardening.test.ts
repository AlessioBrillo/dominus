// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { ListingRepository } from '../../db/repositories/listing-repository.js';
import { ListingManager } from '../listing-manager.js';
import type { ListingProvider, SyncResult } from '../../providers/listing/listing-provider.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import { GateVerdict, type TrademarkGate } from '../../trademark/trademark-gate.js';
import type { Listing } from '../../types/listing.js';

function createTestDb(): SqliteProvider {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE listings (
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
    CREATE UNIQUE INDEX idx_listings_domain_marketplace ON listings(domain, marketplace);
    CREATE TABLE listing_offers (
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
  return new SqliteProvider(db);
}

function createMockEngine(): ScoringEngine {
  return {
    score: vi.fn().mockResolvedValue({
      suggestedListPrice: 2000,
    }),
  } as unknown as ScoringEngine;
}

function createGate(blockedDomains: string[] = []): TrademarkGate {
  return {
    check: vi
      .fn()
      .mockImplementation(async (domain: string) =>
        blockedDomains.includes(domain)
          ? { domain, verdict: GateVerdict.Blocked, verifiedSources: [] as string[] }
          : { domain, verdict: GateVerdict.Clear, verifiedSources: ['USPTO'] },
      ),
  } as unknown as TrademarkGate;
}

function remoteListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 999,
    domain: 'remote.com',
    marketplace: 'afternic',
    externalId: 'af-999',
    listingUrl: 'https://afternic.com/remote',
    priceEur: 2500,
    status: 'listed',
    scoringSnapshotJson: null,
    listedAt: '2025-01-15T10:00:00Z',
    expiresAt: null,
    notes: null,
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

describe('Listing gate hardening', () => {
  it('rejects status escalation through updateListing', async () => {
    const repo = new ListingRepository(createTestDb());
    const provider: ListingProvider = {
      name: 'manual',
      isAvailable: false,
    } as unknown as ListingProvider;
    const manager = new ListingManager(provider, repo, createMockEngine(), createGate());
    const listing = await manager.listDomain('example.com', 'manual', 1000);

    for (const status of ['listed', 'sold', 'offer_received'] as const) {
      await expect(manager.updateListing(listing.id, { status })).rejects.toThrow(
        /publish via listOnMarketplace/,
      );
    }
    expect((await manager.getListing(listing.id))?.status).toBe('draft');
  });

  it('routes remote update/cancel through the stored externalId', async () => {
    const repo = new ListingRepository(createTestDb());
    const seen: string[] = [];
    const provider = {
      name: 'afternic',
      isAvailable: true,
      updateListing: vi.fn(async () => remoteListing()),
      cancelListing: vi.fn(async (externalId: string) => {
        seen.push(externalId);
      }),
      createListing: vi.fn(async () => remoteListing()),
    } as unknown as ListingProvider;
    const manager = new ListingManager(provider, repo, createMockEngine(), createGate());

    const draft = await manager.listDomain('remote.com', 'afternic', 2500);
    const published = await manager.listOnMarketplace(draft.id);
    expect(published.externalId).toBe('af-999');

    await manager.updateListing(draft.id, { priceEur: 2600 });
    expect(provider.updateListing).toHaveBeenCalledWith('af-999', expect.anything());

    await manager.deleteListing(draft.id);
    expect(seen).toEqual(['af-999']);
  });

  it('syncAll matches by externalId and links offers to the local id', async () => {
    const repo = new ListingRepository(createTestDb());
    const provider: ListingProvider = {
      name: 'afternic',
      isAvailable: true,
      sync: vi.fn(async (): Promise<SyncResult> => {
        const listing = remoteListing({ id: 424242, externalId: 'af-424242' });
        return {
          marketplace: 'afternic',
          listings: [listing],
          offers: [
            {
              id: 7,
              listingId: 424242,
              amountEur: 2000,
              buyer: 'buyer1',
              status: 'pending',
              receivedAt: '2025-02-01T00:00:00Z',
              respondedAt: null,
              notes: null,
            },
          ],
          errors: [],
          syncedAt: new Date().toISOString(),
        };
      }),
    } as unknown as ListingProvider;
    const manager = new ListingManager(provider, repo, createMockEngine(), createGate());

    const first = await manager.syncAll();
    expect(first.errors).toHaveLength(0);
    const local = first.listings.find((l) => l.domain === 'remote.com');
    expect(local?.externalId).toBe('af-424242');

    // A second sync must update the same row, not insert a duplicate.
    const second = await manager.syncAll();
    expect(second.listings.filter((l) => l.domain === 'remote.com')).toHaveLength(1);

    const offers = await manager.getOffers(local!.id);
    expect(offers).toHaveLength(1);
    expect(offers[0]!.listingId).toBe(local!.id);
  });

  it('syncAll skips trademark-blocked remotes instead of mirroring them as listed', async () => {
    const repo = new ListingRepository(createTestDb());
    const provider: ListingProvider = {
      name: 'afternic',
      isAvailable: true,
      sync: vi.fn(async (): Promise<SyncResult> => ({
        marketplace: 'afternic',
        listings: [remoteListing({ domain: 'blocked.com' })],
        offers: [],
        errors: [],
        syncedAt: new Date().toISOString(),
      })),
    } as unknown as ListingProvider;
    const manager = new ListingManager(
      provider,
      repo,
      createMockEngine(),
      createGate(['blocked.com']),
    );

    const result = await manager.syncAll();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(await manager.getListings()).toHaveLength(0);
  });

  it('respondToOffer rejects foreign offers and double responses', async () => {
    const repo = new ListingRepository(createTestDb());
    const provider = { name: 'manual', isAvailable: false } as unknown as ListingProvider;
    const manager = new ListingManager(provider, repo, createMockEngine(), createGate());

    const a = await manager.listDomain('a.com', 'manual', 1000);
    const b = await manager.listDomain('b.com', 'manual', 1000);
    const offer = await manager.recordOffer(a.id, 800, 'Buyer1');

    await expect(manager.respondToOffer(offer.id, b.id, 'accepted')).rejects.toThrow(
      /not found for listing/,
    );
    await manager.respondToOffer(offer.id, a.id, 'accepted');
    await expect(manager.respondToOffer(offer.id, a.id, 'declined')).rejects.toThrow(/not pending/);
  });
});
