import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { PredictionAccuracyAnalyzer } from '../prediction-accuracy-analyzer.js';
import { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import type { Outcome } from '../../types/outcome.js';

function createTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      tld TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS scoring_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL REFERENCES candidates(id),
      run_id TEXT NOT NULL,
      expected_value REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      suggested_buy_max REAL NOT NULL DEFAULT 0,
      suggested_list_price REAL NOT NULL DEFAULT 0,
      intrinsic_score REAL NOT NULL DEFAULT 0,
      commercial_score REAL NOT NULL DEFAULT 0,
      market_score REAL NOT NULL DEFAULT 0,
      expiry_score REAL NOT NULL DEFAULT 0,
      weighted_score REAL NOT NULL DEFAULT 0,
      recommended INTEGER NOT NULL DEFAULT 0,
      signal_scores TEXT NOT NULL DEFAULT '{}',
      scored_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS portfolio_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      tld TEXT NOT NULL,
      acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
      renewal_date TEXT NOT NULL DEFAULT (datetime('now', '+1 year')),
      acquisition_cost REAL NOT NULL DEFAULT 10,
      renewal_cost REAL NOT NULL DEFAULT 10,
      registrar TEXT NOT NULL DEFAULT 'manual',
      current_score REAL,
      suggested_list_price REAL,
      verdict TEXT NOT NULL DEFAULT 'keep',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL REFERENCES portfolio_entries(domain) ON DELETE CASCADE,
      type TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      sale_price_eur REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS outcome_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      outcome_type TEXT NOT NULL,
      recommended INTEGER NOT NULL DEFAULT 0,
      weighted_score REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      expected_value REAL NOT NULL DEFAULT 0,
      actual_sale_price REAL,
      tld TEXT NOT NULL,
      scored_at TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      commercial_score REAL NOT NULL DEFAULT 0,
      market_score REAL NOT NULL DEFAULT 0,
      expiry_score REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(domain, occurred_at)
    );
  `);
  return provider;
}

function insertCandidate(db: Database.Database, domain: string, tld: string): number {
  const info = db
    .prepare('INSERT INTO candidates (domain, tld, source) VALUES (?, ?, ?)')
    .run(domain, tld, 'manual');
  return info.lastInsertRowid as number;
}

function insertScoringRun(
  db: Database.Database,
  candidateId: number,
  overrides: Partial<{
    expectedValue: number;
    confidence: number;
    weightedScore: number;
    recommended: number;
    commercialScore: number;
    marketScore: number;
    expiryScore: number;
    scoredAt: string;
  }> = {},
): void {
  db.prepare(
    `INSERT INTO scoring_runs
     (candidate_id, run_id, expected_value, confidence, suggested_buy_max,
      suggested_list_price, intrinsic_score, commercial_score, market_score,
      expiry_score, weighted_score, recommended, signal_scores, scored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    candidateId,
    'test-run',
    overrides.expectedValue ?? 100,
    overrides.confidence ?? 0.7,
    50,
    250,
    0.8,
    overrides.commercialScore ?? 0.5,
    overrides.marketScore ?? 0.3,
    overrides.expiryScore ?? 0.2,
    overrides.weightedScore ?? 0.65,
    overrides.recommended ?? 1,
    '{}',
    overrides.scoredAt ?? '2026-06-01T00:00:00.000Z',
  );
}

interface TestOutcome extends Partial<Outcome> {
  domain: string;
  type: 'sold' | 'dropped' | 'expired';
  occurredAt: string;
  salePriceEur?: number;
}

function insertOutcome(db: Database.Database, outcome: TestOutcome): void {
  db.prepare(
    `INSERT INTO outcomes (domain, type, occurred_at, sale_price_eur)
     VALUES (?, ?, ?, ?)`,
  ).run(outcome.domain, outcome.type, outcome.occurredAt, outcome.salePriceEur ?? null);
}

describe('PredictionAccuracyAnalyzer', () => {
  let provider: SqliteProvider;
  let outcomeRepo: OutcomeRepository;
  let analyzer: PredictionAccuracyAnalyzer;

  beforeEach(() => {
    provider = createTestDb();
    outcomeRepo = new OutcomeRepository(provider);
    analyzer = new PredictionAccuracyAnalyzer(provider.rawDb, outcomeRepo);
  });

  afterEach(() => {
    provider.close();
  });

  describe('generate() — empty state', () => {
    it('returns zeroed report when no outcome_scores exist', () => {
      const report = analyzer.generate();
      expect(report.sampleSize).toBe(0);
      expect(report.warnings.length).toBeGreaterThan(0);
      expect(report.overall.sampleSize).toBe(0);
      expect(report.confusionMatrix.precision).toBe(0);
    });
  });

  describe('refresh() and generate() — with data', () => {
    beforeEach(() => {
      for (const d of ['alpha.com', 'beta.com', 'gamma.io', 'delta.io']) {
        provider.rawDb
          .prepare('INSERT OR IGNORE INTO portfolio_entries (domain, tld) VALUES (?, ?)')
          .run(d, d.includes('io') ? '.io' : '.com');
      }

      const candidateId = insertCandidate(provider.rawDb, 'alpha.com', '.com');
      insertScoringRun(provider.rawDb, candidateId, {
        expectedValue: 200,
        confidence: 0.8,
        weightedScore: 0.75,
        recommended: 1,
        commercialScore: 0.9,
      });

      const candidateId2 = insertCandidate(provider.rawDb, 'beta.com', '.com');
      insertScoringRun(provider.rawDb, candidateId2, {
        expectedValue: 50,
        confidence: 0.2,
        weightedScore: 0.3,
        recommended: 0,
        commercialScore: 0,
      });

      const candidateId3 = insertCandidate(provider.rawDb, 'gamma.io', '.io');
      insertScoringRun(provider.rawDb, candidateId3, {
        expectedValue: 150,
        confidence: 0.6,
        weightedScore: 0.6,
        recommended: 1,
        commercialScore: 0.7,
      });

      const candidateId4 = insertCandidate(provider.rawDb, 'delta.io', '.io');
      insertScoringRun(provider.rawDb, candidateId4, {
        expectedValue: 30,
        confidence: 0.15,
        weightedScore: 0.2,
        recommended: 0,
        commercialScore: 0,
      });

      insertOutcome(provider.rawDb, {
        domain: 'alpha.com',
        type: 'sold',
        occurredAt: '2026-07-01T00:00:00.000Z',
        salePriceEur: 180,
      });
      insertOutcome(provider.rawDb, {
        domain: 'beta.com',
        type: 'sold',
        occurredAt: '2026-07-15T00:00:00.000Z',
        salePriceEur: 80,
      });
      insertOutcome(provider.rawDb, {
        domain: 'gamma.io',
        type: 'dropped',
        occurredAt: '2026-08-01T00:00:00.000Z',
      });
      insertOutcome(provider.rawDb, {
        domain: 'delta.io',
        type: 'expired',
        occurredAt: '2026-08-15T00:00:00.000Z',
      });
    });

    it('refresh() scans and includes outcomes with matching scoring runs', async () => {
      const snapshot = await analyzer.refresh();
      expect(snapshot.scanned).toBe(4);
      expect(snapshot.included).toBe(4);
    });

    it('generate() returns correct sample size after refresh', async () => {
      await analyzer.refresh();
      const report = await analyzer.generate();
      expect(report.sampleSize).toBe(4);
    });

    it('generate() computes correct confusion matrix', async () => {
      await analyzer.refresh();
      const report = analyzer.generate();

      // alpha.com: recommended=1, sold → TP
      // beta.com: recommended=0, sold → FN
      // gamma.io: recommended=1, dropped → FP
      // delta.io: recommended=0, expired → TN
      expect(report.confusionMatrix.truePositives).toBe(1);
      expect(report.confusionMatrix.falseNegatives).toBe(1);
      expect(report.confusionMatrix.falsePositives).toBe(1);
      expect(report.confusionMatrix.trueNegatives).toBe(1);
      expect(report.confusionMatrix.precision).toBeCloseTo(0.5, 2);
      expect(report.confusionMatrix.recall).toBeCloseTo(0.5, 2);
      expect(report.confusionMatrix.f1).toBeCloseTo(0.5, 2);
    });

    it('generate() computes overall accuracy for sold domains with price', async () => {
      await analyzer.refresh();
      const report = analyzer.generate();

      // alpha.com: predicted=200, actual=180 → error=20, ape=11.1%
      // beta.com: predicted=50, actual=80 → error=-30, ape=37.5%
      expect(report.overall.sampleSize).toBe(2);
      expect(report.overall.mape).toBeGreaterThan(0);
    });

    it('generate() returns per-TLD breakdown', async () => {
      await analyzer.refresh();
      const report = analyzer.generate();

      const dotCom = report.byTld.find((t) => t.tld === '.com');
      expect(dotCom).toBeDefined();
      expect(dotCom!.sampleSize).toBe(2);

      const dotIo = report.byTld.find((t) => t.tld === '.io');
      expect(dotIo).toBeUndefined();
    });

    it('generate() returns calibration buckets', async () => {
      await analyzer.refresh();
      const report = analyzer.generate();

      expect(report.calibration.low).toBeDefined();
      expect(report.calibration.mid).toBeDefined();
      expect(report.calibration.high).toBeDefined();
    });

    it('generate() returns signal availability breakdown', async () => {
      await analyzer.refresh();
      const report = analyzer.generate();

      expect(report.bySignalAvailability.length).toBe(3);
      const commercial = report.bySignalAvailability.find((s) => s.signal === 'commercial');
      expect(commercial).toBeDefined();
    });

    it('generate() returns trend', async () => {
      await analyzer.refresh();
      const report = analyzer.generate();

      expect(report.trend.length).toBeGreaterThan(0);
    });
  });
});
