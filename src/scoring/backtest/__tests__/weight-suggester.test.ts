import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../db/migrator.js';
import { SqliteProvider } from '../../../db/provider/sqlite-adapter.js';
import { BacktestSignalsRepository } from '../../../db/repositories/backtest-signals-repository.js';
import { OutcomeRepository } from '../../../db/repositories/outcome-repository.js';
import { PortfolioRepository } from '../../../db/repositories/portfolio-repository.js';
import { CandidateRepository } from '../../../db/repositories/candidate-repository.js';
import { ScoringRepository } from '../../../db/repositories/scoring-repository.js';
import { WeightSuggester } from '../weight-suggester.js';
import { DEFAULT_WEIGHTS, type ScoringWeights } from '../../weights.js';
import { CandidateSource, CandidateStatus } from '../../../types/candidate.js';
import type { ScoreResult } from '../../../types/score.js';

function openTestDb(): SqliteProvider {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const dbProvider = new SqliteProvider(db);
  return dbProvider;
}

interface SeedSignal {
  domain: string;
  intrinsic: number;
  commercial: number;
  market: number;
  expiry: number;
  salePrice: number;
  scoredAt: string;
  occurredAt: string;
}

async function seedSignalRow(dbProvider: SqliteProvider, s: SeedSignal): Promise<void> {
  new PortfolioRepository(dbProvider).insert({
    domain: s.domain,
    tld: '.com',
    acquiredAt: '2025-01-01T00:00:00.000Z',
    renewalDate: '2026-01-01T00:00:00.000Z',
    acquisitionCost: 12,
    renewalCost: 12,
    registrar: 'namecheap',
  });

  const candidateRepo = new CandidateRepository(dbProvider);
  const scoringRepo = new ScoringRepository(dbProvider);
  const candidate = await candidateRepo.insert({
    domain: s.domain,
    tld: '.com',
    source: CandidateSource.KeywordCombo,
    status: CandidateStatus.Recommended,
    isPremium: false,
    pipelineRunId: 'test',
  });

  const result: ScoreResult = {
    domain: s.domain,
    expectedValue: 1000,
    confidence: 0.6,
    suggestedBuyMax: 500,
    suggestedListPrice: 3000,
    weightedScore: 0.5,
    breakdown: {
      intrinsic: { score: s.intrinsic, weight: 0.3, details: {} },
      commercial: { score: s.commercial, weight: 0.35, details: {} },
      market: { score: s.market, weight: 0.25, details: {} },
      expiry: { score: s.expiry, weight: 0.1, details: {} },
    },
    recommended: true,
    scoredAt: s.scoredAt,
    signalStatus: [],
    bidRange: { conservative: 250, aggressive: 500 },
    effectiveWeights: { intrinsic: 0.3, commercial: 0.35, market: 0.25, expiry: 0.1 },
    effectiveRecommendThreshold: 0.4,
    effectiveConfidenceThreshold: 0.3,
  };
  await scoringRepo.insert(candidate.id!, 'test', result);
  dbProvider.rawDb
    .prepare(
      'UPDATE scoring_runs SET scored_at = ? WHERE candidate_id = ? ORDER BY id DESC LIMIT 1',
    )
    .run(s.scoredAt, candidate.id);

  const outcome = await new OutcomeRepository(dbProvider).insert({
    domain: s.domain,
    type: 'sold',
    occurredAt: s.occurredAt,
    salePriceEur: s.salePrice,
  });

  await new BacktestSignalsRepository(dbProvider).upsert({
    domain: s.domain,
    outcomeId: outcome.id!,
    scoringRunId: 'test',
    predictedExpectedValue: 1000,
    predictedBuyMax: 500,
    predictedListPrice: 3000,
    predictedConfidence: 0.6,
    actualSalePriceEur: s.salePrice,
  });
}

describe('WeightSuggester', () => {
  let dbProvider: SqliteProvider;
  let backtestRepo: BacktestSignalsRepository;
  let scoringRepo: ScoringRepository;

  beforeEach(() => {
    dbProvider = openTestDb();
    backtestRepo = new BacktestSignalsRepository(dbProvider);
    scoringRepo = new ScoringRepository(dbProvider);
  });

  it('holds all weights when the sample is too small (<5 sold outcomes)', async () => {
    for (let i = 0; i < 4; i++) {
      await seedSignalRow(dbProvider, {
        domain: `d${i}.com`,
        intrinsic: 0.8,
        commercial: 0.6,
        market: 0.7,
        expiry: 0.0,
        salePrice: 1000 + i * 100,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    const suggester = new WeightSuggester(dbProvider, backtestRepo, scoringRepo);
    const report = await suggester.suggest();
    expect(report.sampleSize).toBe(4);
    expect(report.suggestions.every((s) => s.action === 'hold')).toBe(true);
    expect(report.warnings.join(' ')).toMatch(/below the 5 minimum/);
  });

  it('proposes a positive weight delta when a signal is predictive (high > low)', async () => {
    // 20 rows: 10 with high intrinsic, 10 with low intrinsic.
    // high-intrinsic sold for €1500+ on average, low-intrinsic for €500.
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `high${i}.com`,
        intrinsic: 0.8,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 1500,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `low${i}.com`,
        intrinsic: 0.2,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 500,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    const suggester = new WeightSuggester(dbProvider, backtestRepo, scoringRepo);
    const report = await suggester.suggest();
    const intrinsic = report.suggestions.find((s) => s.signal === 'intrinsic')!;
    expect(intrinsic.action).toBe('apply');
    expect(intrinsic.delta).toBeGreaterThan(0);
    expect(intrinsic.delta).toBeLessThanOrEqual(0.05);
  });

  it('proposes a negative weight delta when high signal underperforms (anti-predictive)', async () => {
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `high${i}.com`,
        intrinsic: 0.8,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 300,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `low${i}.com`,
        intrinsic: 0.2,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 1200,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    const suggester = new WeightSuggester(dbProvider, backtestRepo, scoringRepo);
    const report = await suggester.suggest();
    const intrinsic = report.suggestions.find((s) => s.signal === 'intrinsic')!;
    expect(intrinsic.action).toBe('revert');
    expect(intrinsic.delta).toBeLessThan(0);
  });

  it('renormalises so the suggested weights still sum to ~1.0', async () => {
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `high${i}.com`,
        intrinsic: 0.8,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 2000,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `low${i}.com`,
        intrinsic: 0.2,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 500,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    const suggester = new WeightSuggester(dbProvider, backtestRepo, scoringRepo);
    const report = await suggester.suggest();
    const total = report.suggestions.reduce((acc, s) => acc + s.suggestedWeight, 0);
    expect(Math.abs(total - 1.0)).toBeLessThan(0.01);
  });

  it('holds a signal when the high/low buckets are too small', async () => {
    // 5 outcomes, but only 1 has high intrinsic (the other 4 are low).
    await seedSignalRow(dbProvider, {
      domain: 'one-high.com',
      intrinsic: 0.9,
      commercial: 0.4,
      market: 0.4,
      expiry: 0.0,
      salePrice: 2000,
      scoredAt: '2025-12-01T00:00:00.000Z',
      occurredAt: '2026-04-15T00:00:00.000Z',
    });
    for (let i = 0; i < 4; i++) {
      await seedSignalRow(dbProvider, {
        domain: `low${i}.com`,
        intrinsic: 0.1,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 500,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    const suggester = new WeightSuggester(dbProvider, backtestRepo, scoringRepo);
    const report = await suggester.suggest();
    const intrinsic = report.suggestions.find((s) => s.signal === 'intrinsic')!;
    expect(intrinsic.action).toBe('hold');
    expect(intrinsic.rationale).toMatch(/buckets too small/);
  });

  it('caps individual deltas at ±0.05 (anti-jump safety rail)', async () => {
    // 10 high sold for €5000, 10 low sold for €10. lift = €4990.
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `hi${i}.com`,
        intrinsic: 0.9,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 5000,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `lo${i}.com`,
        intrinsic: 0.1,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 10,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    const suggester = new WeightSuggester(dbProvider, backtestRepo, scoringRepo);
    const report = await suggester.suggest();
    for (const s of report.suggestions) {
      expect(Math.abs(s.delta)).toBeLessThanOrEqual(0.05);
    }
  });

  it('respects a custom current weights config (operator-tuned base)', async () => {
    const customWeights: ScoringWeights = {
      intrinsic: 0.5,
      commercial: 0.2,
      market: 0.2,
      expiry: 0.1,
    };
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `hi${i}.com`,
        intrinsic: 0.8,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 2000,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `lo${i}.com`,
        intrinsic: 0.2,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 500,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    const suggester = new WeightSuggester(dbProvider, backtestRepo, scoringRepo, customWeights);
    const report = await suggester.suggest();
    const intrinsic = report.suggestions.find((s) => s.signal === 'intrinsic')!;
    expect(intrinsic.currentWeight).toBe(0.5);
  });

  it('uses the default weights when none are provided', async () => {
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `hi${i}.com`,
        intrinsic: 0.8,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 2000,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    for (let i = 0; i < 10; i++) {
      await seedSignalRow(dbProvider, {
        domain: `lo${i}.com`,
        intrinsic: 0.2,
        commercial: 0.4,
        market: 0.4,
        expiry: 0.0,
        salePrice: 500,
        scoredAt: '2025-12-01T00:00:00.000Z',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });
    }
    const suggester = new WeightSuggester(dbProvider, backtestRepo, scoringRepo);
    const report = await suggester.suggest();
    const intrinsic = report.suggestions.find((s) => s.signal === 'intrinsic')!;
    expect(intrinsic.currentWeight).toBe(DEFAULT_WEIGHTS.intrinsic);
  });
});
