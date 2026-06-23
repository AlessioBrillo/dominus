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

async function seedScoringSnapshot(
  dbProvider: SqliteProvider,
  domain: string,
  scoredAt: string,
  expectedValue: number,
  buyMax: number,
  listPrice: number,
  confidence: number,
): Promise<void> {
  const candidateRepo = new CandidateRepository(dbProvider);
  const scoringRepo = new ScoringRepository(dbProvider);

  const existing = await candidateRepo.findByDomain(domain);
  const candidate =
    existing ??
    (await candidateRepo.insert({
      domain,
      tld: '.com',
      source: CandidateSource.KeywordCombo,
      status: CandidateStatus.Recommended,
      isPremium: false,
      pipelineRunId: 'test',
    }));

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
  await scoringRepo.insert(candidate.id!, 'test', result);
  dbProvider.rawDb
    .prepare(
      'UPDATE scoring_runs SET scored_at = ? WHERE candidate_id = ? ORDER BY id DESC LIMIT 1',
    )
    .run(scoredAt, candidate.id);
}

async function seedSoldOutcome(
  dbProvider: SqliteProvider,
  domain: string,
  salePrice: number,
  occurredAt: string,
): Promise<number> {
  const outcome = await new OutcomeRepository(dbProvider).insert({
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
    it('writes one signal per sold outcome that has a prior scoring snapshot', async () => {
      seedPortfolio(dbProvider, 'alpha.com');
      seedPortfolio(dbProvider, 'beta.io');
      await seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-12-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      await seedScoringSnapshot(
        dbProvider,
        'beta.io',
        '2025-12-01T00:00:00.000Z',
        800,
        400,
        2400,
        0.5,
      );
      await seedSoldOutcome(dbProvider, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');
      await seedSoldOutcome(dbProvider, 'beta.io', 600, '2026-05-01T00:00:00.000Z');

      const summary = await engine.snapshot();
      expect(summary.scanned).toBe(2);
      expect(summary.inserted).toBe(2);
      expect(summary.skipped).toBe(0);
      expect(await backtestRepo.count()).toBe(2);
    });

    it('skips outcomes whose scoring snapshot does not predate the sale', async () => {
      seedPortfolio(dbProvider, 'alpha.com');
      await seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2026-12-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      await seedSoldOutcome(dbProvider, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');

      const summary = await engine.snapshot();
      expect(summary.inserted).toBe(0);
      expect(summary.skipped).toBe(1);
      expect(await backtestRepo.count()).toBe(0);
    });

    it('skips outcomes without sale_price_eur', async () => {
      seedPortfolio(dbProvider, 'alpha.com');
      await seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-12-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      await new OutcomeRepository(dbProvider).insert({
        domain: 'alpha.com',
        type: 'sold',
        occurredAt: '2026-04-15T00:00:00.000Z',
      });

      const summary = await engine.snapshot();
      expect(summary.inserted).toBe(0);
      expect(summary.skipped).toBe(1);
    });

    it('picks the LAST snapshot whose scored_at <= occurredAt (point-in-time)', async () => {
      seedPortfolio(dbProvider, 'alpha.com');
      await seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-06-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      await seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-12-01T00:00:00.000Z',
        1300,
        650,
        3900,
        0.8,
      );
      await seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2026-12-01T00:00:00.000Z',
        9999,
        9999,
        9999,
        0.9,
      );
      await seedSoldOutcome(dbProvider, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');

      await engine.snapshot();
      const signals = await backtestRepo.findByDomain('alpha.com');
      expect(signals).toHaveLength(1);
      expect(signals[0]?.predictedExpectedValue).toBe(1300);
    });

    it('is idempotent on repeated runs', async () => {
      seedPortfolio(dbProvider, 'alpha.com');
      await seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-12-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      await seedSoldOutcome(dbProvider, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');

      await engine.snapshot();
      await engine.snapshot();
      await engine.snapshot();
      expect(await backtestRepo.count()).toBe(1);
    });
  });

  describe('report()', () => {
    it('returns an empty report on a fresh database', async () => {
      const r = await engine.report();
      expect(r.sampleSize).toBe(0);
      expect(r.meanAbsoluteErrorEur).toBe(0);
      expect(r.biasEur).toBe(0);
      expect(r.buyMaxHitRate).toBe(0);
    });

    it('computes MAE, bias, and buy-max accuracy on seeded signals', async () => {
      seedPortfolio(dbProvider, 'alpha.com');
      seedPortfolio(dbProvider, 'beta.io');
      seedPortfolio(dbProvider, 'gamma.net');
      await seedScoringSnapshot(
        dbProvider,
        'alpha.com',
        '2025-12-01T00:00:00.000Z',
        1000,
        500,
        3000,
        0.7,
      );
      await seedScoringSnapshot(
        dbProvider,
        'beta.io',
        '2025-12-01T00:00:00.000Z',
        800,
        400,
        2400,
        0.4,
      );
      await seedScoringSnapshot(
        dbProvider,
        'gamma.net',
        '2025-12-01T00:00:00.000Z',
        1200,
        600,
        3600,
        0.9,
      );
      await seedSoldOutcome(dbProvider, 'alpha.com', 1500, '2026-04-15T00:00:00.000Z');
      await seedSoldOutcome(dbProvider, 'beta.io', 600, '2026-05-01T00:00:00.000Z');
      await seedSoldOutcome(dbProvider, 'gamma.net', 1800, '2026-06-01T00:00:00.000Z');

      await engine.snapshot();
      const r = await engine.report();

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

    it('produces per-bucket calibration', async () => {
      seedPortfolio(dbProvider, 'a.com');
      seedPortfolio(dbProvider, 'b.com');
      seedPortfolio(dbProvider, 'c.com');
      // low confidence
      await seedScoringSnapshot(
        dbProvider,
        'a.com',
        '2025-12-01T00:00:00.000Z',
        500,
        250,
        1500,
        0.1,
      );
      // mid
      await seedScoringSnapshot(
        dbProvider,
        'b.com',
        '2025-12-01T00:00:00.000Z',
        800,
        400,
        2400,
        0.4,
      );
      // high
      await seedScoringSnapshot(
        dbProvider,
        'c.com',
        '2025-12-01T00:00:00.000Z',
        1500,
        750,
        4500,
        0.8,
      );
      await seedSoldOutcome(dbProvider, 'a.com', 400, '2026-04-01T00:00:00.000Z');
      await seedSoldOutcome(dbProvider, 'b.com', 1000, '2026-05-01T00:00:00.000Z');
      await seedSoldOutcome(dbProvider, 'c.com', 2000, '2026-06-01T00:00:00.000Z');

      await engine.snapshot();
      const r = await engine.report();

      expect(r.calibration.low.n).toBe(1);
      expect(r.calibration.low.meanRealised).toBe(400);
      expect(r.calibration.mid.n).toBe(1);
      expect(r.calibration.high.n).toBe(1);
      expect(r.calibration.high.meanRealised).toBe(2000);
    });
  });
});
