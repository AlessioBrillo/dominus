import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { BacktestSignalsRepository } from '../backtest-signals-repository.js';
import { OutcomeRepository } from '../outcome-repository.js';
import { PortfolioRepository } from '../portfolio-repository.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

function seedPortfolio(provider: SqliteProvider, domain: string): void {
  new PortfolioRepository(provider).insert({
    domain,
    tld: '.com',
    acquiredAt: '2025-01-01T00:00:00.000Z',
    renewalDate: '2026-01-01T00:00:00.000Z',
    acquisitionCost: 12,
    renewalCost: 12,
    registrar: 'namecheap',
  });
}

function seedOutcome(provider: SqliteProvider, domain: string, salePrice: number): number {
  const outcome = new OutcomeRepository(provider).insert({
    domain,
    type: 'sold',
    occurredAt: '2026-04-15T00:00:00.000Z',
    salePriceEur: salePrice,
  });
  return outcome.id!;
}

describe('BacktestSignalsRepository', () => {
  let provider: SqliteProvider;

  beforeEach(() => {
    provider = openTestDb();
  });

  it('upserts a single signal with derived error columns', () => {
    seedPortfolio(provider, 'alpha.com');
    const outcomeId = seedOutcome(provider, 'alpha.com', 1500);

    const repo = new BacktestSignalsRepository(provider);
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
    seedPortfolio(provider, 'a.com');
    seedPortfolio(provider, 'b.com');
    seedPortfolio(provider, 'c.com');
    const o1 = seedOutcome(provider, 'a.com', 1000);
    const o2 = seedOutcome(provider, 'b.com', 1000);
    const o3 = seedOutcome(provider, 'c.com', 1000);

    const repo = new BacktestSignalsRepository(provider);
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
    seedPortfolio(provider, 'alpha.com');
    const outcomeId = seedOutcome(provider, 'alpha.com', 1500);

    const repo = new BacktestSignalsRepository(provider);
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
    seedPortfolio(provider, 'alpha.com');
    const outcomeId = seedOutcome(provider, 'alpha.com', 1500);

    const repo = new BacktestSignalsRepository(provider);
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

    new OutcomeRepository(provider).delete(outcomeId);
    expect(repo.count()).toBe(0);
  });

  it('finds signals by domain', () => {
    seedPortfolio(provider, 'alpha.com');
    seedPortfolio(provider, 'beta.io');
    const o1 = seedOutcome(provider, 'alpha.com', 1500);
    const o2 = seedOutcome(provider, 'beta.io', 800);

    const repo = new BacktestSignalsRepository(provider);
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
