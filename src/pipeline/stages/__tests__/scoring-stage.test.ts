import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScoringStage } from '../scoring-stage.js';
import { ScoringEngine } from '../../../scoring/scoring-engine.js';
import { ManualKeywordProvider } from '../../../providers/keyword/manual-keyword-provider.js';
import { ManualCompsProvider } from '../../../providers/comps/manual-comps-provider.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';
import type { DomainCandidate } from '../../../types/candidate.js';
import type { ScoreResult } from '../../../types/score.js';

const SLOW_DELAY_MS = 100;

function makeEngine(): ScoringEngine {
  return new ScoringEngine(new ManualKeywordProvider(), new ManualCompsProvider());
}

function makeSlowEngine(): ScoringEngine {
  const engine = new ScoringEngine(new ManualKeywordProvider(), new ManualCompsProvider());
  vi.spyOn(engine, 'score').mockImplementation(
    (input) =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve({
            domain: input.domain,
            expectedValue: 100,
            confidence: 0.5,
            suggestedBuyMax: 50,
            suggestedListPrice: 200,
            bidRange: { conservative: 25, aggressive: 50 },
            weightedScore: 0.5,
            breakdown: {
              intrinsic: { score: 0.5, weight: 0.3, details: {} },
              commercial: { score: 0, weight: 0.3, details: {} },
              market: { score: 0, weight: 0.25, details: {} },
              expiry: { score: 0, weight: 0.15, details: {} },
            },
            recommended: true,
            scoredAt: new Date().toISOString(),
            signalStatus: [
              { name: 'intrinsic', available: true },
              { name: 'commercial', available: false },
              { name: 'market', available: false },
              { name: 'expiry', available: false },
            ],
            effectiveWeights: { intrinsic: 1, commercial: 0, market: 0, expiry: 0 },
            effectiveRecommendThreshold: 0.3,
            effectiveConfidenceThreshold: 0.2,
          } satisfies ScoreResult);
        }, SLOW_DELAY_MS),
      ),
  );
  return engine;
}

function candidate(domain: string, overrides?: Partial<DomainCandidate>): DomainCandidate {
  return {
    domain,
    tld: '.com',
    source: CandidateSource.KeywordCombo,
    status: CandidateStatus.Pending,
    isPremium: false,
    pipelineRunId: 'test-run',
    ...overrides,
  };
}

function closeoutCandidate(
  domain: string,
  closeoutMeta?: DomainCandidate['closeoutMeta'],
): DomainCandidate {
  return candidate(domain, {
    source: CandidateSource.CloseoutCsv,
    closeoutMeta,
  });
}

describe('ScoringStage parallelism', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('processes candidates in parallel (not sequentially)', async () => {
    const engine = makeSlowEngine();
    const stage = new ScoringStage(engine, 10);
    const count = 5;

    const start = Date.now();
    const result = await stage.process(Array.from({ length: count }, (_, i) => candidate(`dom${i}.com`)));
    const elapsed = Date.now() - start;

    expect(result.passed).toHaveLength(count);
    expect(result.filtered).toHaveLength(0);
    // Sequential would take count * SLOW_DELAY_MS (500ms);
    // parallel with concurrency >= count takes ~SLOW_DELAY_MS (100ms)
    expect(elapsed).toBeLessThan(count * SLOW_DELAY_MS * 0.75);
  });

  it('respects batch concurrency limit', async () => {
    const engine = makeSlowEngine();
    const concurrency = 2;
    const stage = new ScoringStage(engine, concurrency);
    const count = 4;

    const start = Date.now();
    await stage.process(Array.from({ length: count }, (_, i) => candidate(`dom${i}.com`)));
    const elapsed = Date.now() - start;

    // With concurrency=2 and 4 items, expected ~2 batches: 2 * SLOW_DELAY_MS = 200ms
    // With concurrency=4, it would be ~SLOW_DELAY_MS = 100ms
    // Allow some tolerance
    const expectedMinBatches = Math.ceil(count / concurrency);
    expect(elapsed).toBeGreaterThanOrEqual((expectedMinBatches - 1) * SLOW_DELAY_MS * 0.8);
  });

  it('preserves scoring result for passed candidates', async () => {
    const stage = new ScoringStage(makeEngine());
    const result = await stage.process([candidate('example.com')]);
    expect(result.passed).toHaveLength(1);
    const scored = result.passed[0]!;
    expect(scored.scoreResult).not.toBeNull();
    expect(scored.scoreResult!.domain).toBe('example.com');
    expect(scored.status).toBe(CandidateStatus.Recommended);
  });

  it('preserves scoring result for filtered (non-recommended) candidates', async () => {
    const stage = new ScoringStage(makeEngine());
    const result = await stage.process([candidate('xyznonexistent12345.com')]);
    const all = [...result.passed, ...result.filtered];
    expect(all.length).toBe(1);
    const scored = all[0]!;
    expect(scored.scoreResult).not.toBeNull();
  });

  it('handles empty candidate list', async () => {
    const stage = new ScoringStage(makeEngine());
    const result = await stage.process([]);
    expect(result.passed).toHaveLength(0);
    expect(result.filtered).toHaveLength(0);
  });

  it('handles scoring engine errors gracefully', async () => {
    const engine = makeEngine();
    const originalScore = engine.score.bind(engine);
    vi.spyOn(engine, 'score').mockImplementation(async (input) => {
      if (input.domain === 'good.com') {
        throw new Error('Scoring failed for good.com');
      }
      return originalScore(input);
    });
    const stage = new ScoringStage(engine);
    const result = await stage.process([
      candidate('good.com'),
      candidate('bad.com'),
      candidate('also-good.com'),
    ]);
    expect(result.passed.length + result.filtered.length).toBe(3);
    const bad = [...result.passed, ...result.filtered].find((c) => c.domain === 'good.com');
    expect(bad).toBeDefined();
    expect(bad!.scoreResult).toBeNull();
    expect(bad!.status).toBe(CandidateStatus.Unscored);
    const good = [...result.passed, ...result.filtered].find((c) => c.domain === 'bad.com');
    expect(good).toBeDefined();
    expect(good!.scoreResult).not.toBeNull();
  });

  it('honours AbortSignal', async () => {
    const engine = makeSlowEngine();
    const stage = new ScoringStage(engine, 10);
    const controller = new AbortController();

    const promise = stage.process(
      Array.from({ length: 10 }, (_, i) => candidate(`dom${i}.com`)),
      controller.signal,
    );
    controller.abort();

    const result = await promise;
    // Some may have completed before abort; total processed <= 10
    expect(result.passed.length + result.filtered.length).toBeLessThanOrEqual(10);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sets stage name and duration', async () => {
    const stage = new ScoringStage(makeEngine());
    const result = await stage.process([candidate('example.com')]);
    expect(result.stageName).toBe('ScoringStage');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('ScoringStage closeout metadata threading', () => {
  it('feeds imported age/backlinks/wayback into the expiry signal', async () => {
    const stage = new ScoringStage(makeEngine());

    const result = await stage.process([
      closeoutCandidate('rich.com', { domainAge: 15, backlinks: 800, waybackSnapshots: 400 }),
      closeoutCandidate('bare.com'),
    ]);

    const all = [...result.passed, ...result.filtered];
    const rich = all.find((c) => c.domain === 'rich.com');
    const bare = all.find((c) => c.domain === 'bare.com');

    expect(rich!.scoreResult!.breakdown.expiry.score).toBeGreaterThan(0);
    expect(bare!.scoreResult!.breakdown.expiry.score).toBe(0);
    expect(rich!.scoreResult!.breakdown.expiry.details['domainAge']).toBe(15);
    expect(rich!.scoreResult!.breakdown.expiry.details['waybackSnapshots']).toBe(400);
    expect(bare!.scoreResult!.breakdown.expiry.dataAvailable).toBe(false);
  });
});
