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
