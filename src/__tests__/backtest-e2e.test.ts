import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrator.js';
import { SqliteProvider } from '../db/provider/sqlite-adapter.js';
import { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import { BacktestSignalsRepository } from '../db/repositories/backtest-signals-repository.js';
import { ScoringRepository } from '../db/repositories/scoring-repository.js';
import { BacktestEngine } from '../scoring/backtest/backtest-engine.js';
import { WeightSuggester } from '../scoring/backtest/weight-suggester.js';
import { CandidateSource, CandidateStatus } from '../types/candidate.js';
import type { Outcome } from '../types/outcome.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

function seedScenario(provider: SqliteProvider): void {
  // Need a portfolio entry so OutcomeRepository.insert works (FK constraint)
  provider.rawDb
    .prepare(
      `INSERT INTO portfolio_entries (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost, registrar)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'sold-alpha.com',
      '.com',
      '2025-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
      10,
      12,
      'GoDaddy',
    );
  provider.rawDb
    .prepare(
      `INSERT INTO portfolio_entries (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost, registrar)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'sold-beta.io',
      '.io',
      '2025-01-01T00:00:00.000Z',
      '2027-01-01T00:00:00.000Z',
      10,
      15,
      'Namecheap',
    );

  // Insert a candidate + scoring_run so the point-in-time join works
  provider.rawDb
    .prepare(
      `INSERT INTO candidates (domain, tld, source, status, pipeline_run_id)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      'sold-alpha.com',
      '.com',
      CandidateSource.CloseoutCsv,
      CandidateStatus.Recommended,
      'run-1',
    );

  const candRow = provider.rawDb
    .prepare('SELECT id FROM candidates WHERE domain = ?')
    .get('sold-alpha.com') as { id: number };

  provider.rawDb
    .prepare(
      `INSERT INTO scoring_runs
       (run_id, candidate_id, expected_value, confidence, suggested_buy_max,
        suggested_list_price, intrinsic_score, commercial_score, market_score,
        expiry_score, signal_scores, scored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
  provider.rawDb
    .prepare(
      `INSERT INTO candidates (domain, tld, source, status, pipeline_run_id)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run('sold-beta.io', '.io', CandidateSource.KeywordCombo, CandidateStatus.Scored, 'run-1');

  const candRow2 = provider.rawDb
    .prepare('SELECT id FROM candidates WHERE domain = ?')
    .get('sold-beta.io') as {
    id: number;
  };

  provider.rawDb
    .prepare(
      `INSERT INTO scoring_runs
       (run_id, candidate_id, expected_value, confidence, suggested_buy_max,
        suggested_list_price, intrinsic_score, commercial_score, market_score,
        expiry_score, signal_scores, scored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
  provider.rawDb
    .prepare(
      `INSERT INTO scoring_runs
       (run_id, candidate_id, expected_value, confidence, suggested_buy_max,
        suggested_list_price, intrinsic_score, commercial_score, market_score,
        expiry_score, signal_scores, scored_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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

async function seedOutcome(provider: SqliteProvider): Promise<Outcome> {
  const outcomeRepo = new OutcomeRepository(provider);
  return await outcomeRepo.insert({
    domain: 'sold-alpha.com',
    type: 'sold',
    occurredAt: '2026-03-01T00:00:00.000Z',
    salePriceEur: 450,
  });
}

async function seedSecondOutcome(provider: SqliteProvider): Promise<Outcome> {
  const outcomeRepo = new OutcomeRepository(provider);
  return await outcomeRepo.insert({
    domain: 'sold-beta.io',
    type: 'sold',
    occurredAt: '2026-03-15T00:00:00.000Z',
    salePriceEur: 200,
  });
}

describe('Backtest — end-to-end', () => {
  let provider: SqliteProvider;
  let outcomeRepo: OutcomeRepository;
  let backtestRepo: BacktestSignalsRepository;
  let scoringRepo: ScoringRepository;

  beforeEach(() => {
    provider = openTestDb();
    outcomeRepo = new OutcomeRepository(provider);
    backtestRepo = new BacktestSignalsRepository(provider);
    scoringRepo = new ScoringRepository(provider);
  });

  it('snapshot and report produce correct metrics for one sold outcome', async () => {
    seedScenario(provider);
    await seedOutcome(provider);
    const engine = new BacktestEngine(provider.rawDb, outcomeRepo, backtestRepo);

    // Act — snapshot
    const summary = await engine.snapshot();
    expect(summary.scanned).toBe(1);
    expect(summary.inserted).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.scanned).toBe(1);
    expect(summary.inserted).toBe(1);
    expect(summary.skipped).toBe(0);

    // Act — report
    const report = await engine.report();
    expect(report.sampleSize).toBe(1);
    // actual=450, predicted=500 => MAE=50, bias=450-500=-50
    expect(report.meanAbsoluteErrorEur).toBeCloseTo(50, 1);
    expect(report.biasEur).toBeCloseTo(-50, 1);
    expect(report.buyMaxMeanAbsoluteErrorEur).toBeCloseTo(Math.abs(450 - 200), 1);
    expect(report.medianAbsoluteErrorEur).toBeCloseTo(50, 1);
  });

  it('snapshot point-in-time join prevents lookahead bias', async () => {
    seedScenario(provider);
    await seedOutcome(provider);

    // The scoring_run on 2026-06-01 (run-2, ev=900) should NOT be picked
    // because the sale was on 2026-03-01
    const engine = new BacktestEngine(provider.rawDb, outcomeRepo, backtestRepo);
    const summary = await engine.snapshot();
    expect(summary.inserted).toBe(1);

    const signals = await backtestRepo.findAll();
    expect(signals[0]?.predictedExpectedValue).toBe(500);
    expect(signals[0]?.predictedExpectedValue).not.toBe(900);
  });

  it('snapshot is idempotent — second call does not create duplicate rows', async () => {
    seedScenario(provider);
    await seedOutcome(provider);
    const engine = new BacktestEngine(provider.rawDb, outcomeRepo, backtestRepo);

    const s1 = await engine.snapshot();
    expect(s1.inserted).toBe(1);

    await engine.snapshot();
    // upsert uses ON CONFLICT DO UPDATE, so it returns true but the
    // unique index prevents duplicate (outcome_id, scoring_run_id) rows.
    expect(await backtestRepo.count()).toBe(1);
  });

  it('snapshot handles multiple outcomes', async () => {
    seedScenario(provider);
    await seedOutcome(provider);
    await seedSecondOutcome(provider);
    const engine = new BacktestEngine(provider.rawDb, outcomeRepo, backtestRepo);

    const summary = await engine.snapshot();
    expect(summary.scanned).toBe(2);
    expect(summary.inserted).toBe(2);
    expect(summary.skipped).toBe(0);
  });

  it('weight suggester works end-to-end after snapshot', async () => {
    seedScenario(provider);
    await seedOutcome(provider);
    await seedSecondOutcome(provider);

    const engine = new BacktestEngine(provider.rawDb, outcomeRepo, backtestRepo);
    await engine.snapshot();

    const suggester = new WeightSuggester(provider.rawDb, backtestRepo, scoringRepo);
    const suggestion = await suggester.suggest();
    expect(suggestion.sampleSize).toBe(2);
    expect(suggestion.suggestions.length).toBeGreaterThan(0);
    // With only 2 samples, all signals should hold (minimum 5 for adjustment)
    for (const s of suggestion.suggestions) {
      expect(s.action).toBe('hold');
      expect(s.delta).toBe(0);
    }
  });

  it('report on empty backtest_signals returns zeroes', async () => {
    seedScenario(provider);
    const engine = new BacktestEngine(provider.rawDb, outcomeRepo, backtestRepo);
    const report = await engine.report();
    expect(report.sampleSize).toBe(0);
    expect(report.meanAbsoluteErrorEur).toBe(0);
  });

  it('bad outcome does not abort snapshot', async () => {
    seedScenario(provider);
    // Need portfolio entry for FK, but the domain has no candidate/scoring run
    provider.rawDb
      .prepare(
        `INSERT INTO portfolio_entries (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost, registrar)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'ghost.com',
        '.com',
        '2025-01-01T00:00:00.000Z',
        '2027-01-01T00:00:00.000Z',
        10,
        12,
        'GoDaddy',
      );
    await outcomeRepo.insert({
      domain: 'ghost.com',
      type: 'sold',
      occurredAt: '2026-03-01T00:00:00.000Z',
      salePriceEur: 100,
    });
    await seedOutcome(provider);

    const engine = new BacktestEngine(provider.rawDb, outcomeRepo, backtestRepo);
    const summary = await engine.snapshot();
    expect(summary.scanned).toBe(2);
    expect(summary.inserted).toBe(1);
    expect(summary.skipped).toBe(1);
  });
});
