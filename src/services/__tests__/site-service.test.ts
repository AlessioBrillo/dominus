// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { SiteService, forSalePagePath } from '../site-service.js';

function mockEngine(): {
  score: ReturnType<typeof vi.fn>;
} {
  return {
    score: vi.fn().mockResolvedValue({
      domain: 'vintagecoffee.com',
      expectedValue: 400,
      confidence: 0.6,
      suggestedBuyMax: 200,
      suggestedListPrice: 1200,
      weightedScore: 0.55,
      recommended: true,
    }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockSiteRepo(): any {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    findByDomainPublic: vi.fn().mockResolvedValue({
      domain: 'vintagecoffee.com',
      headline: 'vintagecoffee.com is for sale',
      summary: 'summary',
      askingPriceEur: 1200,
      scoreJson: '{}',
      contact: null,
      publishedAt: '2026-10-13 10:00:00',
      updatedAt: '2026-10-13 10:00:00',
    }),
    listForSitemap: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SiteService', () => {
  it('exposes the canonical for-sale page path', () => {
    expect(forSalePagePath('vintagecoffee.com')).toBe('/public/for-sale/vintagecoffee.com');
  });

  it('reports canBuild=false without a scoring engine', () => {
    const service = new SiteService(mockSiteRepo(), {});
    expect(service.canBuild).toBe(false);
  });

  it('builds the page from the scoring engine and publishes it', async () => {
    const repo = mockSiteRepo();
    const engine = mockEngine();
    const service = new SiteService(repo, {
      engine: engine as never,
      contact: 'owner@example.com',
    });

    const result = await service.publish('vintagecoffee.com');

    expect(engine.score).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'vintagecoffee.com', tld: '.com', sld: 'vintagecoffee' }),
    );
    expect(repo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'vintagecoffee.com',
        askingPriceEur: 1200,
        contact: 'owner@example.com',
        headline: 'vintagecoffee.com is for sale',
      }),
    );
    expect(result.url).toBe('/public/for-sale/vintagecoffee.com');
    expect(result.askingPriceEur).toBe(1200);
  });

  it('publishes with a null contact when none is configured', async () => {
    const repo = mockSiteRepo();
    const service = new SiteService(repo, { engine: mockEngine() as never });
    await service.publish('vintagecoffee.com');
    expect(repo.upsert).toHaveBeenCalledWith(expect.objectContaining({ contact: null }));
  });

  it('unpublish deletes the page', async () => {
    const repo = mockSiteRepo();
    const service = new SiteService(repo, { engine: mockEngine() as never });
    await service.unpublish('vintagecoffee.com');
    expect(repo.delete).toHaveBeenCalledWith('vintagecoffee.com');
  });

  it('build throws when the engine is missing', async () => {
    const service = new SiteService(mockSiteRepo(), {});
    await expect(service.build('vintagecoffee.com')).rejects.toThrow(
      'scoring engine not configured',
    );
  });
});
