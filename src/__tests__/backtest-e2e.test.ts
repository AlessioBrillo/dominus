import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrator.js';
import { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import { BacktestSignalsRepository } from '../db/repositories/backtest-signals-repository.js';
import { ScoringRepository } from '../db/repositories/scoring-repository.js';
import { BacktestEngine } from '../scoring/backtest/backtest-engine.js';
import { WeightSuggester } from '../scoring/backtest/weight-suggester.js';
import { CandidateSource, CandidateStatus } from '../types/candidate.js';
import type { Outcome } from '../types/outcome.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedScenario(db: Database.Database): void {
  // Need a portfolio entry so OutcomeRepository.insert works (FK constraint)
  db.prepare(
    `INSERT INTO portfolio_entries (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost, registrar)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'sold-alpha.com',
    '.com',
    '2025-01-01T00:00:00.000Z',
    '2027-01-01T00:00:00.000Z',
    10,
    12,
    'GoDaddy',
  );
  db.prepare(
    `INSERT INTO portfolio_entries (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost, registrar)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'sold-beta.io',
    '.io',
    '2025-01-01T00:00:00.000Z',
    '2027-01-01T00:00:00.000Z',
    10,
    15,
    'Namecheap',
  );

  // Insert a candidate + scoring_run so the point-in-time join works
  db.prepare(
    `INSERT INTO candidates (domain, tld, source, status, pipeline_run_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'sold-alpha.com',
    '.com',
    CandidateSource.CloseoutCsv,
    CandidateStatus.Recommended,
    'run-1',
  );

  const candRow = db
    .prepare('SELECT id FROM candidates WHERE domain = ?')
    .get('sold-alpha.com') as { id: number };

  db.prepare(
    `INSERT INTO scoring_runs
       (run_id, candidate_id, expected_value, confidence, suggested_buy_max,
        suggested_list_price, intrinsic_score, commercial_score, market_score,
        expiry_score, signal_scores, scored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'run-1',
    candRow.id,
    500,
    0.7,
    200,
    1200,
    0.3,
    0.35,
    0.25,
    0.1,
    '{"intrinsic":0.3,"commercial":0.35,"market":0.25,"expiry":0.1}',
    '2026-01-15T12:00:00.000Z',
  );

  // Seed a second candidate + scoring_run
  db.prepare(
    `INSERT INTO candidates (domain, tld, source, status, pipeline_run_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('sold-beta.io', '.io', CandidateSource.KeywordCombo, CandidateStatus.Scored, 'run-1');

  const candRow2 = db.prepare('SELECT id FROM candidates WHERE domain = ?').get('sold-beta.io') as {
    id: number;
  };

  db.prepare(
    `INSERT INTO scoring_runs
       (run_id, candidate_id, expected_value, confidence, suggested_buy_max,
        suggested_list_price, intrinsic_score, commercial_score, market_score,
        expiry_score, signal_scores, scored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'run-1',
    candRow2.id,
    150,
    0.3,
    50,
    400,
    0.3,
    0.35,
    0.25,
    0.1,
    '{"intrinsic":0.3,"commercial":0.35,"market":0.25,"expiry":0.1}',
    '2026-02-01T12:00:00.000Z',
  );

  // Also add a scoring_run after the sale to ensure point-in-time picks
  // the earlier one (anti-lookahead)
  db.prepare(
    `INSERT INTO scoring_runs
       (run_id, candidate_id, expected_value, confidence, suggested_buy_max,
        suggested_list_price, intrinsic_score, commercial_score, market_score,
        expiry_score, signal_scores, scored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'run-2',
    candRow.id,
    900,
    0.9,
    600,
    2500,
    0.3,
    0.35,
    0.25,
    0.1,
    '{"intrinsic":0.3,"commercial":0.35,"market":0.25,"expiry":0.1}',
    '2026-06-01T12:00:00.000Z',
  );
}

function seedOutcome(db: Database.Database): Outcome {
  const outcomeRepo = new OutcomeRepository(db);
  return outcomeRepo.insert({
    domain: 'sold-alpha.com',
    type: 'sold',
    occurredAt: '2026-03-01T00:00:00.000Z',
    salePriceEur: 450,
  });
}

function seedSecondOutcome(db: Database.Database): Outcome {
  const outcomeRepo = new OutcomeRepository(db);
  return outcomeRepo.insert({
    domain: 'sold-beta.io',
    type: 'sold',
    occurredAt: '2026-03-15T00:00:00.000Z',
    salePriceEur: 200,
  });
}

describe('Backtest — end-to-end', () => {
  let db: Database.Database;
  let outcomeRepo: OutcomeRepository;
  let backtestRepo: BacktestSignalsRepository;
  let scoringRepo: ScoringRepository;

  beforeEach(() => {
    db = openTestDb();
    outcomeRepo = new OutcomeRepository(db);
    backtestRepo = new BacktestSignalsRepository(db);
    scoringRepo = new ScoringRepository(db);
  });

  it('snapshot and report produce correct metrics for one sold outcome', () => {
    seedScenario(db);
    seedOutcome(db);
    const engine = new BacktestEngine(db, outcomeRepo, backtestRepo);

    // Act — snapshot
    const summary = engine.snapshot();
    expect(summary.scanned).toBe(1);
    expect(summary.inserted).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.scanned).toBe(1);
    expect(summary.inserted).toBe(1);
    expect(summary.skipped).toBe(0);

    // Act — report
    const report = engine.report();
    expect(report.sampleSize).toBe(1);
    // actual=450, predicted=500 => MAE=50, bias=450-500=-50
    expect(report.meanAbsoluteErrorEur).toBeCloseTo(50, 1);
    expect(report.biasEur).toBeCloseTo(-50, 1);
    expect(report.buyMaxMeanAbsoluteErrorEur).toBeCloseTo(Math.abs(450 - 200), 1);
    expect(report.medianAbsoluteErrorEur).toBeCloseTo(50, 1);
  });

  it('snapshot point-in-time join prevents lookahead bias', () => {
    seedScenario(db);
    seedOutcome(db);

    // The scoring_run on 2026-06-01 (run-2, ev=900) should NOT be picked
    // because the sale was on 2026-03-01
    const engine = new BacktestEngine(db, outcomeRepo, backtestRepo);
    const summary = engine.snapshot();
    expect(summary.inserted).toBe(1);

    const signals = backtestRepo.findAll();
    expect(signals[0]?.predictedExpectedValue).toBe(500);
    expect(signals[0]?.predictedExpectedValue).not.toBe(900);
  });

  it('snapshot is idempotent — second call does not create duplicate rows', () => {
    seedScenario(db);
    seedOutcome(db);
    const engine = new BacktestEngine(db, outcomeRepo, backtestRepo);

    const s1 = engine.snapshot();
    expect(s1.inserted).toBe(1);

    engine.snapshot();
    // upsert uses ON CONFLICT DO UPDATE, so it returns true but the
    // unique index prevents duplicate (outcome_id, scoring_run_id) rows.
    expect(backtestRepo.count()).toBe(1);
  });

  it('snapshot handles multiple outcomes', () => {
    seedScenario(db);
    seedOutcome(db);
    seedSecondOutcome(db);
    const engine = new BacktestEngine(db, outcomeRepo, backtestRepo);

    const summary = engine.snapshot();
    expect(summary.scanned).toBe(2);
    expect(summary.inserted).toBe(2);
    expect(summary.skipped).toBe(0);
  });

  it('weight suggester works end-to-end after snapshot', () => {
    seedScenario(db);
    seedOutcome(db);
    seedSecondOutcome(db);

    const engine = new BacktestEngine(db, outcomeRepo, backtestRepo);
    engine.snapshot();

    const suggester = new WeightSuggester(db, backtestRepo, scoringRepo);
    const suggestion = suggester.suggest();
    expect(suggestion.sampleSize).toBe(2);
    expect(suggestion.suggestions.length).toBeGreaterThan(0);
    // With only 2 samples, all signals should hold (minimum 5 for adjustment)
    for (const s of suggestion.suggestions) {
      expect(s.action).toBe('hold');
      expect(s.delta).toBe(0);
    }
  });

  it('report on empty backtest_signals returns zeroes', () => {
    seedScenario(db);
    const engine = new BacktestEngine(db, outcomeRepo, backtestRepo);
    const report = engine.report();
    expect(report.sampleSize).toBe(0);
    expect(report.meanAbsoluteErrorEur).toBe(0);
  });

  it('bad outcome does not abort snapshot', () => {
    seedScenario(db);
    // Need portfolio entry for FK, but the domain has no candidate/scoring run
    db.prepare(
      `INSERT INTO portfolio_entries (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost, registrar)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'ghost.com',
      '.com',
      '2025-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
      10,
      12,
      'GoDaddy',
    );
    outcomeRepo.insert({
      domain: 'ghost.com',
      type: 'sold',
      occurredAt: '2026-03-01T00:00:00.000Z',
      salePriceEur: 100,
    });
    seedOutcome(db);

    const engine = new BacktestEngine(db, outcomeRepo, backtestRepo);
    const summary = engine.snapshot();
    expect(summary.scanned).toBe(2);
    expect(summary.inserted).toBe(1);
    expect(summary.skipped).toBe(1);
  });
});
