import { describe, it, expect, vi, assert } from 'vitest';
import { computeMarketScore } from '../market-signal.js';
import type { CompsProvider } from '../../../providers/comps/comps-provider.js';

function mockComps(prices: number[]): CompsProvider {
  return {
    getSales: vi.fn().mockResolvedValue(
      prices.map((p, i) => ({ domain: `comparable${i}.com`, salePrice: p, saleDate: '2024-01-01', venue: 'namebio' })),
    ),
  };
}

describe('MarketSignal', () => {
  it('returns 0 score when no comparables', async () => {
    const result = await computeMarketScore(
      { domain: 'nova.com', tld: '.com', sld: 'nova', isCloseout: false },
      mockComps([]),
      1,
    );
    expect(result.score).toBe(0);
    expect(result.medianSalePrice).toBe(0);
  });

  it('high comparable prices produce high score', async () => {
    const result = await computeMarketScore(
      { domain: 'loans.com', tld: '.com', sld: 'loans', isCloseout: false },
      mockComps([8000, 9000, 10000]),
      1,
    );
    expect(result.score).toBeGreaterThan(0.7);
  });

  it('uses canonical sld for multi-part TLDs', async () => {
    const provider = mockComps([1500, 2000]);
    const result = await computeMarketScore(
      { domain: 'nike.co.uk', tld: '.co.uk', sld: 'nike', isCloseout: false },
      provider,
      1,
    );
    assert(provider.getSales !== undefined);
    expect(provider.getSales).toHaveBeenCalledWith('nike');
    expect(result.score).toBeGreaterThan(0);
  });

  it('median is correctly computed for even list', async () => {
    const result = await computeMarketScore(
      { domain: 'test.com', tld: '.com', sld: 'test', isCloseout: false },
      mockComps([1000, 2000]),
      1,
    );
    expect(result.medianSalePrice).toBe(1500);
  });
});
