// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnonScoringService, DomainValidationError } from '../anon-scoring-service.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';

function createMockEngine(): ScoringEngine {
  return {
    score: vi.fn().mockResolvedValue({
      domain: 'example.com',
      expectedValue: 150,
      confidence: 0.65,
      suggestedBuyMax: 75,
      suggestedListPrice: 300,
      bidRange: { conservative: 48.75, aggressive: 75 },
      weightedScore: 0.55,
      breakdown: {
        intrinsic: {
          score: 0.8,
          details: {
            length: 7,
            hasHyphen: false,
            hasNumbers: false,
            tldBonus: 0.05,
            pronounceabilityScore: 0.9,
          },
        },
        commercial: {
          score: 0.4,
          dataAvailable: true,
          searchVolume: 5000,
          cpc: 2.1,
          providerError: undefined,
        },
        market: {
          score: 0.5,
          dataAvailable: true,
          medianSalePrice: 2000,
          details: { comparables: 3, min: 1000, max: 3000, recencyWeightedAvg: 1800 },
        },
        expiry: {
          score: 0,
          dataAvailable: false,
          ageYears: 0,
          backlinkCount: 0,
          waybackCount: 0,
          hasWaybackData: false,
        },
      },
      recommended: true,
      scoredAt: new Date().toISOString(),
      signalStatus: [
        { name: 'intrinsic', available: true },
        { name: 'commercial', available: true },
        { name: 'market', available: true },
        { name: 'expiry', available: false },
      ],
      effectiveWeights: { intrinsic: 0.25, commercial: 0.35, market: 0.4, expiry: 0 },
      effectiveRecommendThreshold: 0.4,
      effectiveConfidenceThreshold: 0.3,
    }),
  } as unknown as ScoringEngine;
}

function createMockTrademarkGate(verdict: string = 'clear'): TrademarkGate {
  return {
    check: vi.fn().mockResolvedValue({
      verdict,
      verifiedSources: ['USPTO'],
      matchedMark: null,
      matchedOwner: null,
      details: [],
    }),
  } as unknown as TrademarkGate;
}

describe('AnonScoringService', () => {
  let service: AnonScoringService;
  let engine: ScoringEngine;
  let trademarkGate: TrademarkGate;

  beforeEach(() => {
    engine = createMockEngine();
    trademarkGate = createMockTrademarkGate();
    service = new AnonScoringService(engine, trademarkGate, 5000);
  });

  afterEach(() => {
    service.clearCache();
  });

  it('returns score result for a valid domain', async () => {
    const result = await service.score('example.com');

    expect(result.domain).toBe('example.com');
    expect(result.score.expectedValue).toBe(150);
    expect(result.score.confidence).toBe(0.65);
    expect(result.trademark).not.toBeNull();
    expect(result.trademark!.verdict).toBe('clear');
    expect(result.scoredAt).toBeTruthy();
  });

  it('throws DomainValidationError for an invalid domain', async () => {
    await expect(service.score('not-a-domain')).rejects.toThrow(DomainValidationError);
    await expect(service.score('')).rejects.toThrow(DomainValidationError);
    await expect(service.score('   ')).rejects.toThrow(DomainValidationError);
  });

  it('caches results and does not re-score within TTL', async () => {
    const spy = vi.mocked(engine.score);

    await service.score('example.com');
    await service.score('example.com');
    await service.score('example.com');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-scores after cache TTL expires', async () => {
    const spy = vi.mocked(engine.score);
    service = new AnonScoringService(engine, trademarkGate, 1);

    await service.score('example.com');
    await service.score('example.com');
    expect(spy).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    await service.score('example.com');
    expect(spy).toHaveBeenCalledTimes(2);
  }, 10000);

  it('recovers from trademark gate failure with unverified verdict', async () => {
    trademarkGate = {
      check: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as TrademarkGate;
    service = new AnonScoringService(engine, trademarkGate);

    const result = await service.score('example.com');

    expect(result.trademark).not.toBeNull();
    expect(result.trademark!.verdict).toBe('unverified');
    expect(result.trademark!.verifiedSources).toEqual([]);
    expect(result.score.expectedValue).toBe(150);
  });

  it('works without a trademark gate', async () => {
    service = new AnonScoringService(engine);

    const result = await service.score('example.com');

    expect(result.trademark).toBeNull();
    expect(result.score.expectedValue).toBe(150);
  });

  it('clearCache() empties cached entries', async () => {
    const spy = vi.mocked(engine.score);

    await service.score('example.com');
    expect(spy).toHaveBeenCalledTimes(1);

    service.clearCache();

    await service.score('example.com');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('treats domains case-insensitively in cache', async () => {
    const spy = vi.mocked(engine.score);

    await service.score('Example.COM');
    await service.score('example.com');
    await service.score('EXAMPLE.COM');

    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe('valuate()', () => {
    it('includes suggestedBuyMax when trademark verdict is clear', async () => {
      const result = await service.valuate('example.com');

      expect(result.score.suggestedBuyMax).toBe(75);
      expect(result.trademark!.verdict).toBe('clear');
    });

    it('omits suggestedBuyMax when trademark verdict is unverified', async () => {
      trademarkGate = createMockTrademarkGate('unverified');
      service = new AnonScoringService(engine, trademarkGate, 5000);

      const result = await service.valuate('example.com');

      expect(result.trademark!.verdict).toBe('unverified');
      expect(result.score.suggestedBuyMax).toBeUndefined();
    });

    it('omits suggestedBuyMax when trademark verdict is blocked', async () => {
      trademarkGate = createMockTrademarkGate('blocked');
      service = new AnonScoringService(engine, trademarkGate, 5000);

      const result = await service.valuate('example.com');

      expect(result.trademark!.verdict).toBe('blocked');
      expect(result.score.suggestedBuyMax).toBeUndefined();
    });

    it('omits suggestedBuyMax when the trademark gate errors', async () => {
      trademarkGate = {
        check: vi.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as TrademarkGate;
      service = new AnonScoringService(engine, trademarkGate);

      const result = await service.valuate('example.com');

      expect(result.trademark!.verdict).toBe('unverified');
      expect(result.score.suggestedBuyMax).toBeUndefined();
    });

    it('omits suggestedBuyMax when no trademark gate is configured', async () => {
      service = new AnonScoringService(engine);

      const result = await service.valuate('example.com');

      expect(result.trademark).toBeNull();
      expect(result.score.suggestedBuyMax).toBeUndefined();
    });

    it('keeps the remaining score fields intact when buy max is omitted', async () => {
      trademarkGate = createMockTrademarkGate('unverified');
      service = new AnonScoringService(engine, trademarkGate, 5000);

      const result = await service.valuate('example.com');

      expect(result.score.expectedValue).toBe(150);
      expect(result.score.confidence).toBe(0.65);
      expect(result.score.suggestedListPrice).toBe(300);
      expect(result.score.weightedScore).toBe(0.55);
    });

    it('throws DomainValidationError for an invalid domain', async () => {
      await expect(service.valuate('not-a-domain')).rejects.toThrow(DomainValidationError);
      await expect(service.valuate('')).rejects.toThrow(DomainValidationError);
    });

    it('caches results and does not re-score within TTL', async () => {
      const spy = vi.mocked(engine.score);

      await service.valuate('example.com');
      await service.valuate('example.com');
      await service.valuate('example.com');

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('uses a cache separate from score()', async () => {
      const spy = vi.mocked(engine.score);

      await service.score('example.com');
      await service.valuate('example.com');

      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
