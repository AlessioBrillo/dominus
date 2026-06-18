import { describe, it, expect } from 'vitest';
import { suggestListPrice, suggestFastSellPrice } from '../listing-pricing.js';
import type { ScoreResult } from '../../types/score.js';

function makeScore(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    domain: 'example.com',
    expectedValue: 800,
    confidence: 0.65,
    suggestedBuyMax: 350,
    suggestedListPrice: 2000,
    weightedScore: 0.72,
    recommended: true,
    scoredAt: new Date().toISOString(),
    breakdown: {} as never,
    signalStatus: [],
    effectiveWeights: { intrinsic: 0.3, commercial: 0.3, market: 0.2, expiry: 0.2 },
    effectiveRecommendThreshold: 0.4,
    effectiveConfidenceThreshold: 0.3,
    bidRange: { conservative: 200, aggressive: 350 },
    ...overrides,
  };
}

describe('suggestListPrice', () => {
  it('returns minimum price when no score is available', () => {
    const result = suggestListPrice(undefined);
    expect(result.suggestedEur).toBe(5);
    expect(result.confidence).toBe('low');
  });

  it('returns price based on scoring engine when available', () => {
    const score = makeScore({ suggestedListPrice: 2000, confidence: 0.8 });
    const result = suggestListPrice(score);

    expect(result.suggestedEur).toBeGreaterThan(0);
    expect(result.rationale.length).toBeGreaterThan(0);
  });

  it('adjusts price for low confidence', () => {
    const highConf = makeScore({ suggestedListPrice: 2000, confidence: 0.9 });
    const lowConf = makeScore({ suggestedListPrice: 2000, confidence: 0.2 });

    const highResult = suggestListPrice(highConf);
    const lowResult = suggestListPrice(lowConf);

    expect(lowResult.suggestedEur).toBeLessThan(highResult.suggestedEur);
  });

  it('penalises price when trademark signal is blocked', () => {
    const score = makeScore({
      suggestedListPrice: 2000,
      signalStatus: [
        { name: 'intrinsic', available: true },
        { name: 'trademark', available: false },
      ],
    });

    const result = suggestListPrice(score);
    expect(result.suggestedEur).toBeLessThan(2000);
  });

  it('provides min and max range around suggested price', () => {
    const score = makeScore({ suggestedListPrice: 2000, confidence: 0.8 });
    const result = suggestListPrice(score);

    expect(result.minEur).toBeLessThanOrEqual(result.suggestedEur);
    expect(result.maxEur).toBeGreaterThanOrEqual(result.suggestedEur);
  });

  it('returns high confidence for scores >= 0.6', () => {
    const score = makeScore({ confidence: 0.7 });
    const result = suggestListPrice(score);
    expect(result.confidence).toBe('high');
  });

  it('returns low confidence for scores < 0.3', () => {
    const score = makeScore({ confidence: 0.2 });
    const result = suggestListPrice(score);
    expect(result.confidence).toBe('low');
  });
});

describe('suggestFastSellPrice', () => {
  it('returns 65% of suggested list price', () => {
    const score = makeScore({ suggestedListPrice: 2000 });
    expect(suggestFastSellPrice(score)).toBe(1300);
  });
});
