// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnonScoringService, DomainValidationError } from '../anon-scoring-service.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { TrademarkGate } from '../../trademark/trademark-gate.js';
import type { PublicScoreRepository } from '../../db/repositories/public-score-repository.js';
import { AnonBudgetGate } from '../../providers/anon-budget-gate.js';
import { RateLimiter } from '../../providers/rate-limiter.js';

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

type FakeRepo = PublicScoreRepository & {
  insert: ReturnType<typeof vi.fn>;
  findBySlug: ReturnType<typeof vi.fn>;
  findBySlugsForCompare: ReturnType<typeof vi.fn>;
  updateViewCount: ReturnType<typeof vi.fn>;
  listRecentScores: ReturnType<typeof vi.fn>;
  pruneOlderThan: ReturnType<typeof vi.fn>;
  findForOgImage: ReturnType<typeof vi.fn>;
};

function makeFakeRepo(): FakeRepo {
  return {
    insert: vi.fn().mockResolvedValue(undefined),
    findBySlug: vi.fn().mockResolvedValue(null),
    findBySlugsForCompare: vi.fn().mockResolvedValue({ row1: null, row2: null }),
    updateViewCount: vi.fn().mockResolvedValue(undefined),
    listRecentScores: vi.fn().mockResolvedValue([]),
    pruneOlderThan: vi.fn().mockResolvedValue(0),
    findForOgImage: vi.fn().mockResolvedValue(null),
  } as unknown as FakeRepo;
}

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

  describe('createScore()', () => {
    it('stores the full score (including suggestedBuyMax) when trademark is clear', async () => {
      const repo = makeFakeRepo();
      service = new AnonScoringService(engine, trademarkGate, 5000, 100, repo);

      await service.createScore('example.com');

      const [slug, , scoreJson] = repo.insert.mock.calls[0]!;
      expect(slug).toBeTypeOf('string');
      const stored = JSON.parse(scoreJson);
      expect(stored.suggestedBuyMax).toBe(75);
    });

    it('strips suggestedBuyMax from the stored score when trademark is unverified', async () => {
      trademarkGate = createMockTrademarkGate('unverified');
      const repo = makeFakeRepo();
      service = new AnonScoringService(engine, trademarkGate, 5000, 100, repo);

      await service.createScore('example.com');

      const stored = JSON.parse(repo.insert.mock.calls[0]![2]);
      expect(stored.suggestedBuyMax).toBeUndefined();
      expect(stored.expectedValue).toBe(150);
    });

    it('strips suggestedBuyMax from the stored score when trademark is blocked', async () => {
      trademarkGate = createMockTrademarkGate('blocked');
      const repo = makeFakeRepo();
      service = new AnonScoringService(engine, trademarkGate, 5000, 100, repo);

      await service.createScore('example.com');

      const stored = JSON.parse(repo.insert.mock.calls[0]![2]);
      expect(stored.suggestedBuyMax).toBeUndefined();
    });

    it('strips suggestedBuyMax when the trademark gate errors', async () => {
      trademarkGate = {
        check: vi.fn().mockRejectedValue(new Error('Network error')),
      } as unknown as TrademarkGate;
      const repo = makeFakeRepo();
      service = new AnonScoringService(engine, trademarkGate, 5000, 100, repo);

      await service.createScore('example.com');

      const stored = JSON.parse(repo.insert.mock.calls[0]![2]);
      expect(stored.suggestedBuyMax).toBeUndefined();
    });

    it('strips suggestedBuyMax when no trademark gate is configured', async () => {
      const repo = makeFakeRepo();
      service = new AnonScoringService(engine, undefined, 5000, 100, repo);

      await service.createScore('example.com');

      const stored = JSON.parse(repo.insert.mock.calls[0]![2]);
      expect(stored.suggestedBuyMax).toBeUndefined();
    });
  });

  describe('read-time sanitization (defense-in-depth for legacy rows)', () => {
    const legacyRow = {
      slug: 'abc123def456',
      domain: 'example.com',
      score_json: JSON.stringify({
        domain: 'example.com',
        expectedValue: 150,
        confidence: 0.65,
        suggestedBuyMax: 75,
        suggestedListPrice: 300,
        weightedScore: 0.55,
      }),
      view_count: 1,
      created_at: '2025-01-15T00:00:00.000Z',
    };

    it('getScoreBySlug strips suggestedBuyMax for non-clear trademark', async () => {
      const repo = makeFakeRepo();
      repo.findBySlug.mockResolvedValue({
        ...legacyRow,
        trademark_json: JSON.stringify({ verdict: 'unverified', verifiedSources: [] }),
      });
      service = new AnonScoringService(engine, undefined, 5000, 100, repo);

      const data = await service.getScoreBySlug('abc123def456');

      expect(data).not.toBeNull();
      expect(data!.score.suggestedBuyMax).toBeUndefined();
      expect(data!.score.expectedValue).toBe(150);
    });

    it('getScoreBySlug keeps suggestedBuyMax when trademark is clear', async () => {
      const repo = makeFakeRepo();
      repo.findBySlug.mockResolvedValue({
        ...legacyRow,
        trademark_json: JSON.stringify({ verdict: 'clear', verifiedSources: ['USPTO'] }),
      });
      service = new AnonScoringService(engine, undefined, 5000, 100, repo);

      const data = await service.getScoreBySlug('abc123def456');

      expect(data!.score.suggestedBuyMax).toBe(75);
    });

    it('getCompareScores strips suggestedBuyMax per-score based on trademark', async () => {
      const repo = makeFakeRepo();
      repo.findBySlugsForCompare.mockResolvedValue({
        row1: {
          ...legacyRow,
          slug: 'abc123def456',
          trademark_json: JSON.stringify({ verdict: 'clear', verifiedSources: ['USPTO'] }),
        },
        row2: {
          ...legacyRow,
          slug: 'xyz789def456',
          domain: 'test.org',
          trademark_json: JSON.stringify({ verdict: 'blocked', verifiedSources: ['USPTO'] }),
        },
      });
      service = new AnonScoringService(engine, undefined, 5000, 100, repo);

      const result = await service.getCompareScores('abc123def456', 'xyz789def456');

      expect(result).not.toBeNull();
      expect(result!.score1.score.suggestedBuyMax).toBe(75);
      expect(result!.score2.score.suggestedBuyMax).toBeUndefined();
    });
  });

  describe('view count flush', () => {
    it('deduplicates retry and live buffers per slug before flushing', async () => {
      vi.useFakeTimers();
      try {
        const repo = makeFakeRepo();
        repo.updateViewCount
          .mockRejectedValueOnce(new Error('db down'))
          .mockResolvedValue(undefined);
        service = new AnonScoringService(engine, trademarkGate, 5000, 100, repo);

        service.bumpViewCount('slug1');
        await vi.advanceTimersByTimeAsync(60_000);

        service.bumpViewCount('slug1');
        await vi.advanceTimersByTimeAsync(60_000);

        expect(repo.updateViewCount).toHaveBeenCalledTimes(2);
        expect(repo.updateViewCount).toHaveBeenLastCalledWith('slug1', 2);
      } finally {
        service.dispose();
        vi.useRealTimers();
      }
    });

    it('batches distinct slugs in a single flush cycle', async () => {
      vi.useFakeTimers();
      try {
        const repo = makeFakeRepo();
        service = new AnonScoringService(engine, trademarkGate, 5000, 100, repo);

        service.bumpViewCount('slug1');
        service.bumpViewCount('slug2');
        await vi.advanceTimersByTimeAsync(60_000);

        expect(repo.updateViewCount).toHaveBeenCalledTimes(2);
      } finally {
        service.dispose();
        vi.useRealTimers();
      }
    });
  });

  describe('anonymous trademark budget (ADR-0056)', () => {
    it('runs the trademark gate when the budget grants a slot', async () => {
      const limiter = new RateLimiter({
        maxTokens: 2,
        tokensPerInterval: 2,
        intervalMs: 1_000_000,
      });
      const gate = new AnonBudgetGate(limiter, { enabled: true, acquireTimeoutMs: 100 });
      const onGranted = vi.fn();
      service = new AnonScoringService(engine, trademarkGate, 5000, 500, undefined, gate, onGranted);

      const result = await service.valuate('example.com');

      expect(result.trademark!.verdict).toBe('clear');
      expect(result.score.suggestedBuyMax).toBe(75);
      expect(vi.mocked(trademarkGate.check)).toHaveBeenCalledTimes(1);
      expect(onGranted).toHaveBeenCalledWith(true);
    });

    it('fails open to unverified when the budget is exhausted', async () => {
      const limiter = new RateLimiter({
        maxTokens: 1,
        tokensPerInterval: 1,
        intervalMs: 1_000_000,
      });
      const gate = new AnonBudgetGate(limiter, { enabled: true, acquireTimeoutMs: 50 });
      const onGranted = vi.fn();
      service = new AnonScoringService(engine, trademarkGate, 5000, 500, undefined, gate, onGranted);

      const first = await service.valuate('domain-a.com');
      const result = await service.valuate('domain-b.com');

      expect(first.trademark!.verdict).toBe('clear');
      expect(result.trademark!.verdict).toBe('unverified');
      expect(result.trademark!.verifiedSources).toEqual([]);
      expect(result.score.suggestedBuyMax).toBeUndefined();
      expect(vi.mocked(trademarkGate.check)).toHaveBeenCalledTimes(1);
      expect(onGranted).toHaveBeenNthCalledWith(1, true);
      expect(onGranted).toHaveBeenNthCalledWith(2, false);
    });

    it('never invokes the trademark gate when the budget is denied', async () => {
      const limiter = new RateLimiter({
        maxTokens: 0,
        tokensPerInterval: 1,
        intervalMs: 1_000_000,
      });
      const gate = new AnonBudgetGate(limiter, { enabled: true, acquireTimeoutMs: 50 });
      service = new AnonScoringService(engine, trademarkGate, 5000, 500, undefined, gate);

      const result = await service.score('example.com');

      expect(result.trademark!.verdict).toBe('unverified');
      expect(vi.mocked(trademarkGate.check)).not.toHaveBeenCalled();
    });

    it('does not report budget outcomes when no budget gate is wired', async () => {
      const onGranted = vi.fn();
      service = new AnonScoringService(
        engine,
        trademarkGate,
        5000,
        500,
        undefined,
        undefined,
        onGranted,
      );

      await service.valuate('example.com');

      expect(onGranted).not.toHaveBeenCalled();
      expect(vi.mocked(trademarkGate.check)).toHaveBeenCalledTimes(1);
    });
  });
});
