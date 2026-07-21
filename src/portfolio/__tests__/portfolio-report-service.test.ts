import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import { OutcomeRepository } from '../../db/repositories/outcome-repository.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { PortfolioReportService } from '../portfolio-report-service.js';
import { Verdict } from '../../types/portfolio.js';
import type { AddPortfolioEntryInput } from '../../types/portfolio.js';

function openTestDb(): SqliteProvider {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return new SqliteProvider(db);
}

function makePortfolioInput(
  domain: string,
  overrides: Partial<AddPortfolioEntryInput> = {},
): AddPortfolioEntryInput {
  return {
    domain,
    tld: '.com',
    acquiredAt: new Date(Date.now() - 365 * 86_400_000).toISOString(),
    renewalDate: new Date(Date.now() + 200 * 86_400_000).toISOString(),
    acquisitionCost: 10,
    renewalCost: 10,
    registrar: 'namecheap',
    ...overrides,
  };
}

describe('PortfolioReportService', () => {
  let db: SqliteProvider;
  let portfolioRepo: PortfolioRepository;
  let outcomeRepo: OutcomeRepository;
  let service: PortfolioReportService;

  beforeEach(() => {
    db = openTestDb();
    portfolioRepo = new PortfolioRepository(db);
    outcomeRepo = new OutcomeRepository(db);
    service = new PortfolioReportService(portfolioRepo, outcomeRepo, 25, 30);
  });

  describe('generate', () => {
    it('returns zeroed report when portfolio is empty', async () => {
      const report = await service.generate();
      expect(report.totalDomains).toBe(0);
      expect(report.totalAcquisitionCost).toBe(0);
      expect(report.totalAnnualRenewalCost).toBe(0);
      expect(report.monthlyBurnRate).toBe(0);
      expect(report.breakdownByVerdict).toEqual([]);
      expect(report.breakdownByTld).toEqual([]);
      expect(report.domainsAtRisk).toEqual([]);
    });

    it('computes aggregate metrics for scored domains', async () => {
      await portfolioRepo.insert(makePortfolioInput('alpha.com'));
      await portfolioRepo.insert(makePortfolioInput('beta.com'));

      await portfolioRepo.updateScore('alpha.com', 50, 1000);
      await portfolioRepo.updateScore('beta.com', 30, 500);

      const report = await service.generate();
      expect(report.totalDomains).toBe(2);
      expect(report.domainsWithScore).toBe(2);
      expect(report.averageScore).toBe(40);
      expect(report.totalSuggestedListPrice).toBe(1500);
      expect(report.totalAcquisitionCost).toBe(20);
      expect(report.totalAnnualRenewalCost).toBe(20);
      expect(report.monthlyBurnRate).toBeCloseTo(20 / 12, 1);
    });

    it('includes realised revenue from sold outcomes', async () => {
      await portfolioRepo.insert(makePortfolioInput('sold.com'));
      await outcomeRepo.insert({
        domain: 'sold.com',
        type: 'sold',
        occurredAt: new Date().toISOString(),
        salePriceEur: 500,
        notes: undefined,
      });

      const report = await service.generate();
      expect(report.totalRealisedRevenue).toBe(500);
    });

    it('computes net profit as revenue minus acquisition and renewal costs', async () => {
      await portfolioRepo.insert(makePortfolioInput('sold.com', { acquisitionCost: 50 }));
      await outcomeRepo.insert({
        domain: 'sold.com',
        type: 'sold',
        occurredAt: new Date().toISOString(),
        salePriceEur: 200,
        notes: undefined,
      });
      await outcomeRepo.insert({
        domain: 'sold.com',
        type: 'renewed',
        occurredAt: new Date(Date.now() - 100 * 86_400_000).toISOString(),
        notes: undefined,
      });

      const report = await service.generate();
      expect(report.totalRenewalCostPaid).toBe(10);
      expect(report.netProfit).toBe(200 - 50 - 10);
    });

    it('computes ROI percentage', async () => {
      await portfolioRepo.insert(makePortfolioInput('sold.com', { acquisitionCost: 100 }));
      await outcomeRepo.insert({
        domain: 'sold.com',
        type: 'sold',
        occurredAt: new Date().toISOString(),
        salePriceEur: 150,
        notes: undefined,
      });

      const report = await service.generate();
      const expectedRoi = ((150 - 100) / 100) * 100;
      expect(report.roiPct).toBeCloseTo(expectedRoi, 1);
    });

    it('groups by verdict in breakdownByVerdict', async () => {
      await portfolioRepo.insert(makePortfolioInput('keep.com'));
      await portfolioRepo.insert(makePortfolioInput('drop.com'));
      await portfolioRepo.updateVerdict('drop.com', Verdict.Drop);

      const report = await service.generate();
      const keepVerdict = report.breakdownByVerdict.find((v) => v.verdict === 'keep');
      const dropVerdict = report.breakdownByVerdict.find((v) => v.verdict === 'drop');
      expect(keepVerdict?.count).toBe(1);
      expect(dropVerdict?.count).toBe(1);
    });

    it('groups by TLD in breakdownByTld', async () => {
      await portfolioRepo.insert(makePortfolioInput('alpha.com'));
      await portfolioRepo.insert(makePortfolioInput('beta.io', { tld: '.io' }));

      const report = await service.generate();
      const comTld = report.breakdownByTld.find((t) => t.tld === '.com');
      const ioTld = report.breakdownByTld.find((t) => t.tld === '.io');
      expect(comTld?.count).toBe(1);
      expect(ioTld?.count).toBe(1);
    });

    it('identifies domains at risk (low score or approaching renewal)', async () => {
      const nearRenewal = new Date(Date.now() + 10 * 86_400_000).toISOString();
      await portfolioRepo.insert(makePortfolioInput('risky.com', { renewalDate: nearRenewal }));

      const report = await service.generate();
      expect(report.domainsAtRisk.length).toBeGreaterThanOrEqual(1);
      expect(report.domainsAtRisk[0]?.domain).toBe('risky.com');
    });

    it('computes aggregate NPV for scored domains', async () => {
      await portfolioRepo.insert(makePortfolioInput('good.com'));
      await portfolioRepo.updateScore('good.com', 80, 5000);

      const report = await service.generate();
      expect(report.aggregateNpv).not.toBe(0);
      expect(report.aggregateProjectedAnnualReturn).not.toBe(0);
    });
  });

  describe('domainRoi', () => {
    it('returns null for unknown domain', async () => {
      const result = await service.domainRoi('unknown.com');
      expect(result).toBeNull();
    });

    it('returns holding status for a domain with no outcomes', async () => {
      await portfolioRepo.insert(makePortfolioInput('hold.com'));
      const result = await service.domainRoi('hold.com');
      expect(result?.status).toBe('holding');
      expect(result?.salePriceEur).toBeUndefined();
    });

    it('returns sold status with correct P&L', async () => {
      await portfolioRepo.insert(makePortfolioInput('sold.com', { acquisitionCost: 20 }));
      await outcomeRepo.insert({
        domain: 'sold.com',
        type: 'sold',
        occurredAt: new Date().toISOString(),
        salePriceEur: 300,
        notes: undefined,
      });

      const result = await service.domainRoi('sold.com');
      expect(result?.status).toBe('sold');
      expect(result?.salePriceEur).toBe(300);
      expect(result?.grossProfit).toBe(300 - 20);
    });

    it('returns dropped status', async () => {
      await portfolioRepo.insert(makePortfolioInput('dropped.com'));
      await outcomeRepo.insert({
        domain: 'dropped.com',
        type: 'dropped',
        occurredAt: new Date().toISOString(),
        notes: undefined,
      });

      const result = await service.domainRoi('dropped.com');
      expect(result?.status).toBe('dropped');
    });
  });

  describe('allRoi', () => {
    it('returns empty report when portfolio is empty', async () => {
      const report = await service.allRoi();
      expect(report.totalDomains).toBe(0);
      expect(report.domainDetails).toEqual([]);
    });

    it('returns per-domain ROI for all portfolio entries', async () => {
      await portfolioRepo.insert(makePortfolioInput('alpha.com'));
      await portfolioRepo.insert(makePortfolioInput('beta.com'));

      const report = await service.allRoi();
      expect(report.totalDomains).toBe(2);
      expect(report.domainDetails).toHaveLength(2);
    });

    it('computes aggregate NPV across all domains', async () => {
      await portfolioRepo.insert(makePortfolioInput('good.com'));
      await portfolioRepo.updateScore('good.com', 75, 3000);

      const report = await service.allRoi();
      expect(report.aggregateNpv).not.toBe(0);
    });
  });
});
