import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { PnlService } from '../pnl-service.js';
import type { RecordOutcomeInput } from '../../types/outcome.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertPortfolio(
  repo: PortfolioRepository,
  domain: string,
  overrides: Partial<{
    tld: string;
    acquisitionCost: number;
    renewalCost: number;
    registrar: string;
    verdict: string;
  }> = {},
): void {
  repo.insert({
    domain,
    tld: overrides.tld ?? 'com',
    acquiredAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    renewalDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    acquisitionCost: overrides.acquisitionCost ?? 10,
    renewalCost: overrides.renewalCost ?? 9.5,
    registrar: overrides.registrar ?? 'manual',
    notes: undefined,
  });
}

function makeOutcome(
  domain: string,
  type: 'sold' | 'dropped' | 'expired' | 'renewed',
  overrides: Partial<{
    salePriceEur: number;
    acquisitionCostEur: number;
    totalRenewalCostEur: number;
  }> = {},
): RecordOutcomeInput {
  const input = {
    domain,
    type,
    occurredAt: new Date().toISOString(),
    salePriceEur: type === 'sold' ? (overrides.salePriceEur ?? 100) : undefined,
    acquisitionCostEur: overrides.acquisitionCostEur,
    totalRenewalCostEur: overrides.totalRenewalCostEur,
    notes: undefined,
  };
  return input;
}

describe('PnlService', () => {
  let db: Database.Database;
  let portfolioRepo: PortfolioRepository;
  let outcomeRepo: OutcomeRepository;

  beforeEach(() => {
    db = openTestDb();
    portfolioRepo = new PortfolioRepository(db);
    outcomeRepo = new OutcomeRepository(db);
  });

  it('returns zeroed summary when portfolio is empty', () => {
    const svc = new PnlService(portfolioRepo, []);
    const report = svc.generate();
    expect(report.summary.totalInvestmentEur).toBe(0);
    expect(report.summary.totalReturnsEur).toBe(0);
    expect(report.summary.netPnlEur).toBe(0);
    expect(report.summary.roiPct).toBe(0);
    expect(report.summary.totalCount).toBe(0);
    expect(report.perDomain).toEqual([]);
    expect(report.monthlyTrend).toEqual([]);
  });

  it('computes correct P&L for one domain with no sale', () => {
    insertPortfolio(portfolioRepo, 'example.com', {
      acquisitionCost: 10,
      renewalCost: 9.5,
    });
    const svc = new PnlService(portfolioRepo, []);
    const report = svc.generate();
    expect(report.summary.totalInvestmentEur).toBe(10);
    expect(report.summary.totalReturnsEur).toBe(0);
    expect(report.summary.netPnlEur).toBe(-19.5);
    expect(report.summary.holdingCostsEur).toBe(9.5);
    expect(report.summary.totalCount).toBe(1);
    expect(report.summary.soldCount).toBe(0);
  });

  it('computes correct P&L for a sold domain', () => {
    insertPortfolio(portfolioRepo, 'sold.com', {
      acquisitionCost: 15,
      renewalCost: 9.5,
    });
    outcomeRepo.insert(
      makeOutcome('sold.com', 'sold', {
        salePriceEur: 200,
        acquisitionCostEur: 15,
        totalRenewalCostEur: 9.5,
      }),
    );
    const outcomes = outcomeRepo.findAll();
    const svc = new PnlService(portfolioRepo, outcomes);
    const report = svc.generate();
    expect(report.summary.totalInvestmentEur).toBe(15);
    expect(report.summary.totalReturnsEur).toBe(200);
    expect(report.summary.netPnlEur).toBe(200 - 15 - 9.5);
    expect(report.summary.soldCount).toBe(1);
    expect(report.summary.roiPct).toBeCloseTo(((200 - 15 - 9.5) / (15 + 9.5)) * 100, 1);
  });

  it('shows negative P&L when holding costs exceed sale price', () => {
    insertPortfolio(portfolioRepo, 'loser.com', {
      acquisitionCost: 100,
      renewalCost: 50,
    });
    outcomeRepo.insert(
      makeOutcome('loser.com', 'sold', {
        salePriceEur: 80,
      }),
    );
    const outcomes = outcomeRepo.findAll();
    const svc = new PnlService(portfolioRepo, outcomes);
    const report = svc.generate();
    expect(report.summary.netPnlEur).toBe(80 - 100 - 50);
    expect(report.summary.roiPct).toBeLessThan(0);
  });

  it('handles multiple domains with mixed outcomes', () => {
    insertPortfolio(portfolioRepo, 'winner.com', { acquisitionCost: 10, renewalCost: 9.5 });
    insertPortfolio(portfolioRepo, 'loser.com', { acquisitionCost: 50, renewalCost: 10 });
    insertPortfolio(portfolioRepo, 'holdling.com', { acquisitionCost: 8, renewalCost: 8 });

    outcomeRepo.insert(makeOutcome('winner.com', 'sold', { salePriceEur: 300 }));
    outcomeRepo.insert(makeOutcome('loser.com', 'dropped'));

    const outcomes = outcomeRepo.findAll();
    const svc = new PnlService(portfolioRepo, outcomes);
    const report = svc.generate();

    expect(report.summary.totalInvestmentEur).toBe(10 + 50 + 8);
    expect(report.summary.totalReturnsEur).toBe(300);
    expect(report.summary.totalCount).toBe(3);
    expect(report.summary.soldCount).toBe(1);

    expect(report.perDomain).toHaveLength(3);
    expect(report.perDomain[0]!.netPnlEur).toBeGreaterThanOrEqual(report.perDomain[1]!.netPnlEur);
  });

  it('includes domains sold with no sale price in per-domain breakdown', () => {
    insertPortfolio(portfolioRepo, 'freesold.com', { acquisitionCost: 5, renewalCost: 5 });
    outcomeRepo.insert(makeOutcome('freesold.com', 'sold', { salePriceEur: 0 }));
    const outcomes = outcomeRepo.findAll();
    const svc = new PnlService(portfolioRepo, outcomes);
    const report = svc.generate();
    const entry = report.perDomain.find((d) => d.domain === 'freesold.com');
    expect(entry).toBeDefined();
    expect(entry!.salePriceEur).toBe(0);
    expect(entry!.netPnlEur).toBe(0 - 5 - 5);
  });

  it('generates monthly trend with investments and returns', () => {
    insertPortfolio(portfolioRepo, 'bought-last-month.com', {
      acquisitionCost: 20,
      renewalCost: 10,
    });
    outcomeRepo.insert({
      domain: 'bought-last-month.com',
      type: 'sold',
      occurredAt: new Date().toISOString(),
      salePriceEur: 100,
      notes: undefined,
    });

    const outcomes = outcomeRepo.findAll();
    const svc = new PnlService(portfolioRepo, outcomes);
    const report = svc.generate();

    expect(report.monthlyTrend.length).toBeGreaterThanOrEqual(1);
    const trend = report.monthlyTrend.find((m) => m.investmentEur > 0 || m.returnsEur > 0);
    expect(trend).toBeDefined();
  });
});
