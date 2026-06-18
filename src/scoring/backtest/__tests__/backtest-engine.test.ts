import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../db/migrator.js';
import { SqliteProvider } from '../../../db/provider/sqlite-adapter.js';
import { BacktestEngine } from '../backtest-engine.js';
import { OutcomeRepository } from '../../../db/repositories/outcome-repository.js';
import { BacktestSignalsRepository } from '../../../db/repositories/backtest-signals-repository.js';
import { PortfolioRepository } from '../../../db/repositories/portfolio-repository.js';
import { CandidateRepository } from '../../../db/repositories/candidate-repository.js';
import { ScoringRepository } from '../../../db/repositories/scoring-repository.js';
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

function seedPortfolio(dbProvider: SqliteProvider, domain: string): void {
  new PortfolioRepository(dbProvider).insert({
    domain,
    tld: '.com',
    acquiredAt: '2025-01-01T00:00:00.000Z',
    renewalDate: '2026-01-01T00:00:00.000Z',
    acquisitionCost: 12,
    renewalCost: 12,
    registrar: 'namecheap',
  });
}

function seedScoringSnapshot(
  dbProvider: SqliteProvider,
  domain: string,
  scoredAt: string,
  expectedValue: number,
  buyMax: number,
  listPrice: number,
  confidence: number,
): void {
  const candidateRepo = new CandidateRepository(dbProvider);
  const scoringRepo = new ScoringRepository(dbProvider);

  const existing = candidateRepo.findByDomain(domain);
  const candidate =
    existing ??
    candidateRepo.insert({
      domain,
      tld: '.com',
      source: CandidateSource.KeywordCombo,
      status: CandidateStatus.Recommended,
      isPremium: false,
      pipelineRunId: 'test',
    });

  const result: ScoreResult = {
    domain,
    expectedValue,
    confidence,
    suggestedBuyMax: buyMax,
    suggestedListPrice: listPrice,
    weightedScore: expectedValue / 1000,
    breakdown: {
      intrinsic: { score: 0.5, weight: 0.3, details: {} },
      commercial: { score: 0.5, weight: 0.35, details: {} },
      market: { score: 0.5, weight: 0.25, details: {} },
      expiry: { score: 0, weight: 0.1, details: {} },
    },
    recommended: true,
    scoredAt,
    signalStatus: [],
    bidRange: { conservative: 250, aggressive: 500 },
    effectiveWeights: { intrinsic: 0.3, commercial: 0.35, market: 0.25, expiry: 0.1 },
    effectiveRecommendThreshold: 0.4,
    effectiveConfidenceThreshold: 0.3,
  };

  // Manually set scored_at via direct update (the repo does not accept a custom timestamp).
  scoringRepo.insert(candidate.id!, 'test', result);
  dbProvider.rawDb
    .prepare(
      'UPDATE scoring_runs SET scored_at = ? WHERE candidate_id = ? ORDER BY id DESC LIMIT 1',
    )
    .run(scoredAt, candidate.id);
}

function seedSoldOutcome(
  dbProvider: SqliteProvider,
  domain: string,
  salePrice: number,
  occurredAt: string,
): number {
  const outcome = new OutcomeRepository(dbProvider).insert({
    domain,
    type: 'sold',
    occurredAt,
    salePriceEur: salePrice,
  });
  return outcome.id!;
}

describe('BacktestEngine', () => {
  let db: Database.Database;
  let dbProvider: SqliteProvider;
  let engine: BacktestEngine;
  let backtestRepo: BacktestSignalsRepository;
  let outcomeRepo: OutcomeRepository;

  beforeEach(() => {
    dbProvider = openTestDb();
    db = dbProvider.rawDb;
    outcomeRepo = new OutcomeRepository(dbProvider);
    backtestRepo = new BacktestSignalsRepository(dbProvider);
    engine = new BacktestEngine(db, outcomeRepo, backtestRepo);
  });

  describe('snapshot()', () => {
    it('writes one signal per sold outcome that has a prior scoring snapshot', () => {
      seedPortfolio(dbProvider, 'alpha.com');
      seedPortfolio(dbProvider, 'beta.io');
      seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-12-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      seedScoringSnapshot(dbProvider, 'beta.io', '2025-12-01T00:00:00.000Z', 800, 400, 2400, 0.5);
      seedSoldOutcome(dbProvider, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');
      seedSoldOutcome(dbProvider, 'beta.io', 600, '2026-05-01T00:00:00.000Z');

      const summary = engine.snapshot();
      expect(summary.scanned).toBe(2);
      expect(summary.inserted).toBe(2);
      expect(summary.skipped).toBe(0);
      expect(backtestRepo.count()).toBe(2);
    });

    it('skips outcomes whose scoring snapshot does not predate the sale', () => {
      seedPortfolio(dbProvider, 'alpha.com');
      seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2026-12-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      seedSoldOutcome(dbProvider, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');

      const summary = engine.snapshot();
      expect(summary.inserted).toBe(0);
      expect(summary.skipped).toBe(1);
      expect(backtestRepo.count()).toBe(0);
    });

    it('skips outcomes without sale_price_eur', () => {
      seedPortfolio(dbProvider, 'alpha.com');
      seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-12-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      new OutcomeRepository(dbProvider).insert({
        domain: 'alpha.com',
        type: 'sold',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });

      const summary = engine.snapshot();
      expect(summary.inserted).toBe(0);
      expect(summary.skipped).toBe(1);
    });

    it('picks the LAST snapshot whose scored_at <= occurredAt (point-in-time)', () => {
      seedPortfolio(dbProvider, 'alpha.com');
      seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-06-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-12-01T00:00:00.000Z',
        1300,
        650,
        3900,
        0.8,
      );
      seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2026-12-01T00:00:00.000Z',
        9999,
        9999,
        9999,
        0.9,
      );
      seedSoldOutcome(dbProvider, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');

      engine.snapshot();
      const signals = backtestRepo.findByDomain('alpha.com');
      expect(signals).toHaveLength(1);
      expect(signals[0]?.predictedExpectedValue).toBe(1300);
    });

    it('is idempotent on repeated runs', () => {
      seedPortfolio(dbProvider, 'alpha.com');
      seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-12-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      seedSoldOutcome(dbProvider, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');

      engine.snapshot();
      engine.snapshot();
      engine.snapshot();
      expect(backtestRepo.count()).toBe(1);
    });
  });

  describe('report()', () => {
    it('returns an empty report on a fresh database', () => {
      const r = engine.report();
      expect(r.sampleSize).toBe(0);
      expect(r.meanAbsoluteErrorEur).toBe(0);
      expect(r.biasEur).toBe(0);
      expect(r.buyMaxHitRate).toBe(0);
    });

    it('computes MAE, bias, and buy-max accuracy on seeded signals', () => {
      seedPortfolio(dbProvider, 'alpha.com');
      seedPortfolio(dbProvider, 'beta.io');
      seedPortfolio(dbProvider, 'gamma.net');
      seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-12-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      seedScoringSnapshot(dbProvider, 'beta.io', '2025-12-01T00:00:00.000Z', 800, 400, 2400, 0.4);
      seedScoringSnapshot(
        dbProvider,
        'gamma.net',
        '2025-12-01T00:00:00.000Z',
        1200,
        600,
        3600,
        0.9,
      );
      seedSoldOutcome(dbProvider, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');
      seedSoldOutcome(dbProvider, 'beta.io', 600, '2026-05-01T00:00:00.000Z');
      seedSoldOutcome(dbProvider, 'gamma.net', 1800, '2026-06-01T00:00:00.000Z');

      engine.snapshot();
      const r = engine.report();

      expect(r.sampleSize).toBe(3);
      // alpha: |1000-1500|=500, beta: |800-600|=200, gamma: |1200-1800|=600 → MAE = 433.33
      expect(r.meanAbsoluteErrorEur).toBeCloseTo(433.33, 1);
      // median: 500
      expect(r.medianAbsoluteErrorEur).toBe(500);
      // alpha: +500, beta: -200, gamma: +600 → mean +300
      expect(r.biasEur).toBeCloseTo(300, 1);
      // alpha 1500>500 ✓, beta 600>400 ✓, gamma 1800>600 ✓ → 3/3
      expect(r.buyMaxHitRate).toBe(1);
    });

    it('produces per-bucket calibration', () => {
      seedPortfolio(dbProvider, 'a.com');
      seedPortfolio(dbProvider, 'b.com');
      seedPortfolio(dbProvider, 'c.com');
      // low confidence
      seedScoringSnapshot(dbProvider, 'a.com', '2025-12-01T00:00:00.000Z', 500, 250, 1500, 0.1);
      // mid
      seedScoringSnapshot(dbProvider, 'b.com', '2025-12-01T00:00:00.000Z', 800, 400, 2400, 0.4);
      // high
      seedScoringSnapshot(dbProvider, 'c.com', '2025-12-01T00:00:00.000Z', 1500, 750, 4500, 0.8);
      seedSoldOutcome(dbProvider, 'a.com', 400, '2026-04-01T00:00:00.000Z');
      seedSoldOutcome(dbProvider, 'b.com', 1000, '2026-05-01T00:00:00.000Z');
      seedSoldOutcome(dbProvider, 'c.com', 2000, '2026-06-01T00:00:00.000Z');

      engine.snapshot();
      const r = engine.report();

      expect(r.calibration.low.n).toBe(1);
      expect(r.calibration.low.meanRealised).toBe(400);
      expect(r.calibration.mid.n).toBe(1);
      expect(r.calibration.high.n).toBe(1);
      expect(r.calibration.high.meanRealised).toBe(2000);
    });
  });
});
