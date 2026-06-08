import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { BacktestSignalsRepository } from '../backtest-signals-repository.js';
import { OutcomeRepository } from '../outcome-repository.js';
import { PortfolioRepository } from '../portfolio-repository.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedPortfolio(db: Database.Database, domain: string): void {
  new PortfolioRepository(db).insert({
    domain,
    tld: '.com',
    acquiredAt: '2025-01-01T00:00:00.000Z',
    renewalDate: '2026-01-01T00:00:00.000Z',
    acquisitionCost: 12,
    renewalCost: 12,
    registrar: 'namecheap',
  });
}

function seedOutcome(db: Database.Database, domain: string, salePrice: number): number {
  const outcome = new OutcomeRepository(db).insert({
    domain,
    type: 'sold',
    occurredAt: '2026-04-15T00:00:00.000Z',
    salePriceEur: salePrice,
  });
  return outcome.id!;
}

describe('BacktestSignalsRepository', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  it('upserts a single signal with derived error columns', () => {
    seedPortfolio(db, 'alpha.com');
    const outcomeId = seedOutcome(db, 'alpha.com', 1500);

    const repo = new BacktestSignalsRepository(db);
    const sig = repo.upsert({
      domain: 'alpha.com',
      outcomeId,
      scoringRunId: 'run-1',
      predictedExpectedValue: 1200,
      predictedBuyMax: 600,
      predictedListPrice: 3600,
      predictedConfidence: 0.7,
      actualSalePriceEur: 1500,
    });

    expect(sig.id).toBeDefined();
    expect(sig.absoluteErrorEur).toBe(300);
    expect(sig.signedErrorEur).toBe(300);
    expect(sig.confidenceBucket).toBe('high');
    expect(sig.recordedAt).toBeDefined();
  });

  it('buckets low / mid / high confidence correctly', () => {
    seedPortfolio(db, 'a.com');
    seedPortfolio(db, 'b.com');
    seedPortfolio(db, 'c.com');
    const o1 = seedOutcome(db, 'a.com', 1000);
    const o2 = seedOutcome(db, 'b.com', 1000);
    const o3 = seedOutcome(db, 'c.com', 1000);

    const repo = new BacktestSignalsRepository(db);
    expect(
      repo.upsert({
        domain: 'a.com',
        outcomeId: o1,
        scoringRunId: 'r',
        predictedExpectedValue: 1000,
        predictedBuyMax: 500,
        predictedListPrice: 3000,
        predictedConfidence: 0.1,
        actualSalePriceEur: 1000,
      }).confidenceBucket,
    ).toBe('low');
    expect(
      repo.upsert({
        domain: 'b.com',
        outcomeId: o2,
        scoringRunId: 'r',
        predictedExpectedValue: 1000,
        predictedBuyMax: 500,
        predictedListPrice: 3000,
        predictedConfidence: 0.45,
        actualSalePriceEur: 1000,
      }).confidenceBucket,
    ).toBe('mid');
    expect(
      repo.upsert({
        domain: 'c.com',
        outcomeId: o3,
        scoringRunId: 'r',
        predictedExpectedValue: 1000,
        predictedBuyMax: 500,
        predictedListPrice: 3000,
        predictedConfidence: 0.8,
        actualSalePriceEur: 1000,
      }).confidenceBucket,
    ).toBe('high');
  });

  it('upsert is idempotent on (outcome_id, scoring_run_id)', () => {
    seedPortfolio(db, 'alpha.com');
    const outcomeId = seedOutcome(db, 'alpha.com', 1500);

    const repo = new BacktestSignalsRepository(db);
    repo.upsert({
      domain: 'alpha.com',
      outcomeId,
      scoringRunId: 'run-1',
      predictedExpectedValue: 1200,
      predictedBuyMax: 600,
      predictedListPrice: 3600,
      predictedConfidence: 0.7,
      actualSalePriceEur: 1500,
    });
    repo.upsert({
      domain: 'alpha.com',
      outcomeId,
      scoringRunId: 'run-1',
      predictedExpectedValue: 1200,
      predictedBuyMax: 600,
      predictedListPrice: 3600,
      predictedConfidence: 0.7,
      actualSalePriceEur: 1500,
    });

    expect(repo.count()).toBe(1);
    expect(repo.findByOutcome(outcomeId)).toHaveLength(1);
  });

  it('cascade-deletes signals when the parent outcome is removed', () => {
    seedPortfolio(db, 'alpha.com');
    const outcomeId = seedOutcome(db, 'alpha.com', 1500);

    const repo = new BacktestSignalsRepository(db);
    repo.upsert({
      domain: 'alpha.com',
      outcomeId,
      scoringRunId: 'run-1',
      predictedExpectedValue: 1200,
      predictedBuyMax: 600,
      predictedListPrice: 3600,
      predictedConfidence: 0.7,
      actualSalePriceEur: 1500,
    });
    expect(repo.count()).toBe(1);

    new OutcomeRepository(db).delete(outcomeId);
    expect(repo.count()).toBe(0);
  });

  it('finds signals by domain', () => {
    seedPortfolio(db, 'alpha.com');
    seedPortfolio(db, 'beta.io');
    const o1 = seedOutcome(db, 'alpha.com', 1500);
    const o2 = seedOutcome(db, 'beta.io', 800);

    const repo = new BacktestSignalsRepository(db);
    repo.upsert({
      domain: 'alpha.com',
      outcomeId: o1,
      scoringRunId: 'r',
      predictedExpectedValue: 1200,
      predictedBuyMax: 600,
      predictedListPrice: 3600,
      predictedConfidence: 0.7,
      actualSalePriceEur: 1500,
    });
    repo.upsert({
      domain: 'beta.io',
      outcomeId: o2,
      scoringRunId: 'r',
      predictedExpectedValue: 1000,
      predictedBuyMax: 500,
      predictedListPrice: 3000,
      predictedConfidence: 0.5,
      actualSalePriceEur: 800,
    });

    const alphaSigs = repo.findByDomain('alpha.com');
    expect(alphaSigs).toHaveLength(1);
    expect(alphaSigs[0]?.domain).toBe('alpha.com');

    const all = repo.findAll();
    expect(all).toHaveLength(2);
  });
});
