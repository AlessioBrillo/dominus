import { describe, it, expect, vi } from 'vitest';
import { ScoringEngine } from '../scoring-engine.js';
import type { KeywordProvider } from '../../providers/keyword/keyword-provider.js';
import type { CompsProvider } from '../../providers/comps/comps-provider.js';

function makeProviders(volume = 0, cpc = 0, compPrices: number[] = []): {
  keyword: KeywordProvider;
  comps: CompsProvider;
} {
  return {
    keyword: { getMetrics: vi.fn().mockResolvedValue({ term: 'test', monthlySearchVolume: volume, cpc, competition: 0 }) },
    comps: {
      getSales: vi.fn().mockResolvedValue(
        compPrices.map((p) => ({ domain: 'comp.com', salePrice: p, saleDate: '2024-01-01', venue: 'namebio' })),
      ),
    },
  };
}

describe('ScoringEngine', () => {
  it('suggestedBuyMax is always ≤ expectedValue × 0.5', async () => {
    const { keyword, comps } = makeProviders(50_000, 5, [2000, 3000]);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({ domain: 'nova.com', tld: '.com', sld: 'nova', isCloseout: false });
    expect(result.suggestedBuyMax).toBeLessThanOrEqual(result.expectedValue * 0.5 + 0.01);
  });

  it('suggestedListPrice is greater than expectedValue', async () => {
    const { keyword, comps } = makeProviders(50_000, 5, [2000]);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({ domain: 'nova.com', tld: '.com', sld: 'nova', isCloseout: false });
    expect(result.suggestedListPrice).toBeGreaterThan(result.expectedValue);
  });

  it('domain with no keyword or comps data is not recommended', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({ domain: 'xyzqwerty123.com', tld: '.com', sld: 'xyzqwerty123', isCloseout: false });
    expect(result.recommended).toBe(false);
  });

  it('confidence is between 0 and 1', async () => {
    const { keyword, comps } = makeProviders(100_000, 10, [5000]);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({ domain: 'saas.com', tld: '.com', sld: 'saas', isCloseout: false });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('returns structured ScoreBreakdown with all four signals', async () => {
    const { keyword, comps } = makeProviders();
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({ domain: 'nova.com', tld: '.com', sld: 'nova', isCloseout: false });
    expect(result.breakdown).toHaveProperty('intrinsic');
    expect(result.breakdown).toHaveProperty('commercial');
    expect(result.breakdown).toHaveProperty('market');
    expect(result.breakdown).toHaveProperty('expiry');
  });

  it('exposes a 0-1 weightedScore derived from the breakdown', async () => {
    const { keyword, comps } = makeProviders(50_000, 5, [2000, 3000]);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({ domain: 'nova.com', tld: '.com', sld: 'nova', isCloseout: false });

    // Recompute the expected weighted score from the breakdown — proves the
    // engine is not making the field up.
    const { intrinsic, commercial, market, expiry } = result.breakdown;
    const expected = Math.round(
      (intrinsic.score * intrinsic.weight +
        commercial.score * commercial.weight +
        market.score * market.weight +
        expiry.score * expiry.weight) *
        1000,
    ) / 1000;

    expect(result.weightedScore).toBe(expected);
    expect(result.weightedScore).toBeGreaterThanOrEqual(0);
    expect(result.weightedScore).toBeLessThanOrEqual(1);
  });
});
