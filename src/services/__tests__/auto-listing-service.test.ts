// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { AutoListingService } from '../auto-listing-service.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockListingManager(): any {
  return {
    getListings: vi.fn(),
    listDomain: vi.fn(),
    refreshPricing: vi.fn(),
    updateListing: vi.fn(),
    cancelListing: vi.fn(),
    recordOffer: vi.fn(),
    getOffers: vi.fn(),
    syncAll: vi.fn(),
    getListing: vi.fn(),
    getListingsByStatus: vi.fn(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockAutoListingRepo(): any {
  return {
    insert: vi.fn(),
    findByDomain: vi.fn(),
    findByListingId: vi.fn(),
    findBySource: vi.fn(),
    updateStatus: vi.fn(),
    supersedeByDomain: vi.fn(),
  };
}

function makeListing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    domain: 'example.com',
    marketplace: 'manual' as const,
    listingUrl: null,
    priceEur: 1500,
    status: 'draft' as const,
    scoringSnapshotJson: null,
    listedAt: null,
    expiresAt: null,
    notes: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('AutoListingService', () => {
  describe('autoList', () => {
    it('returns skipped when listDomain fails', async () => {
      const mgr = createMockListingManager();
      mgr.getListings.mockResolvedValue([]);
      mgr.listDomain.mockRejectedValue(new Error('Marketplace API unavailable'));

      const repo = createMockAutoListingRepo();
      const svc = new AutoListingService(mgr, repo);

      const result = await svc.autoList('example.com', null, 'manual');
      expect(result.skipped).toBe(true);
      if (result.skipped) {
        expect(result.reason).toBe('error');
        expect(result.message).toContain('Marketplace API unavailable');
      }
    });
    it('skips when domain already has a listing on target marketplace', async () => {
      const mgr = createMockListingManager();
      mgr.getListings.mockResolvedValue([makeListing({ marketplace: 'manual' })]);

      const repo = createMockAutoListingRepo();
      const svc = new AutoListingService(mgr, repo);

      const result = await svc.autoList('example.com', null, 'purchase');
      expect(result.skipped).toBe(true);
      if (result.skipped) {
        expect(result.reason).toBe('already_listed');
      }
      expect(mgr.listDomain).not.toHaveBeenCalled();
    });

    it('lists domain and records auto-listing', async () => {
      const mgr = createMockListingManager();
      mgr.getListings.mockResolvedValue([]);
      mgr.listDomain.mockResolvedValue(makeListing({ id: 42 }));

      const repo = createMockAutoListingRepo();
      const svc = new AutoListingService(mgr, repo);

      const result = await svc.autoList('example.com', null, 'purchase');
      expect(result.skipped).toBe(false);
      if (!result.skipped) {
        expect(result.listing.id).toBe(42);
        expect(result.source).toBe('purchase');
      }
      expect(repo.insert).toHaveBeenCalledWith({
        domain: 'example.com',
        listingId: 42,
        triggerSource: 'purchase',
        pipelineRunId: null,
        scoreSnapshotJson: null,
      });
    });

    it('attaches score snapshot when provided', async () => {
      const mgr = createMockListingManager();
      mgr.getListings.mockResolvedValue([]);
      mgr.listDomain.mockResolvedValue(makeListing({ id: 7 }));

      const repo = createMockAutoListingRepo();
      const svc = new AutoListingService(mgr, repo);

      const score = { domain: 'example.com' } as never;
      const result = await svc.autoList('example.com', score, 'pipeline_run', 'run-abc');
      expect(result.skipped).toBe(false);
      expect(repo.insert).toHaveBeenCalledWith({
        domain: 'example.com',
        listingId: 7,
        triggerSource: 'pipeline_run',
        pipelineRunId: 'run-abc',
        scoreSnapshotJson: expect.any(String),
      });
    });

    it('propagates error when getListings fails', async () => {
      const mgr = createMockListingManager();
      mgr.getListings.mockRejectedValue(new Error('DB connection lost'));

      const repo = createMockAutoListingRepo();
      const svc = new AutoListingService(mgr, repo);

      await expect(svc.autoList('example.com', null, 'manual')).rejects.toThrow(
        'DB connection lost',
      );
    });

    it('uses the scoring price when no settings store is wired', async () => {
      const mgr = createMockListingManager();
      mgr.getListings.mockResolvedValue([]);
      mgr.listDomain.mockResolvedValue(makeListing({ id: 1 }));

      const svc = new AutoListingService(mgr, createMockAutoListingRepo());
      await svc.autoList('example.com', { suggestedListPrice: 2000 } as never, 'purchase');

      expect(mgr.listDomain).toHaveBeenCalledWith('example.com', 'manual', 2000);
    });

    it('uses the tenant base price when the policy is fixed (M4)', async () => {
      const mgr = createMockListingManager();
      mgr.getListings.mockResolvedValue([]);
      mgr.listDomain.mockResolvedValue(makeListing({ id: 1, priceEur: 2500 }));

      const settingsRepo = {
        get: vi.fn().mockResolvedValue({
          pricePolicy: 'fixed',
          basePriceEur: 2500,
          offerAutoDeclineBelowEur: null,
          offerCounterEur: null,
        }),
      };

      const svc = new AutoListingService(mgr, createMockAutoListingRepo(), settingsRepo as never);
      await svc.autoList('example.com', { suggestedListPrice: 2000 } as never, 'purchase');

      expect(mgr.listDomain).toHaveBeenCalledWith('example.com', 'manual', 2500);
    });

    it('falls back to the scoring price when the policy is scoring (M4)', async () => {
      const mgr = createMockListingManager();
      mgr.getListings.mockResolvedValue([]);
      mgr.listDomain.mockResolvedValue(makeListing({ id: 1 }));

      const settingsRepo = {
        get: vi.fn().mockResolvedValue({
          pricePolicy: 'scoring',
          basePriceEur: 2500,
          offerAutoDeclineBelowEur: null,
          offerCounterEur: null,
        }),
      };

      const svc = new AutoListingService(mgr, createMockAutoListingRepo(), settingsRepo as never);
      await svc.autoList('example.com', { suggestedListPrice: 2000 } as never, 'purchase');

      expect(mgr.listDomain).toHaveBeenCalledWith('example.com', 'manual', 2000);
    });
  });

  describe('autoListBatch', () => {
    it('lists multiple domains and returns counts', async () => {
      const mgr = createMockListingManager();
      mgr.getListings
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeListing({ marketplace: 'manual' })]);
      mgr.listDomain
        .mockResolvedValueOnce(makeListing({ id: 1, domain: 'alpha.com' }))
        .mockResolvedValueOnce(makeListing({ id: 2, domain: 'beta.io' }));

      const repo = createMockAutoListingRepo();
      repo.insert.mockResolvedValue({ id: 1 });

      const svc = new AutoListingService(mgr, repo);

      const result = await svc.autoListBatch(
        [
          { domain: 'alpha.com', score: null },
          { domain: 'beta.io', score: null },
          { domain: 'gamma.org', score: null },
        ],
        'acquisition',
      );

      expect(result.listed).toHaveLength(2);
      expect(result.skipped).toHaveLength(1);
    });
  });
});
