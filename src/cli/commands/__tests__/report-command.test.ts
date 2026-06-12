import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import type { PortfolioReportService } from '../../../portfolio/portfolio-report-service.js';
import type { PortfolioReport, RoiReport } from '../../../types/portfolio-report.js';
import { registerReportCommand } from '../report-command.js';

function makeEmptyReport(): PortfolioReport {
  return {
    generatedAt: new Date().toISOString(),
    totalDomains: 0,
    totalAcquisitionCost: 0,
    totalAnnualRenewalCost: 0,
    monthlyBurnRate: 0,
    domainsWithScore: 0,
    domainsWithListPrice: 0,
    averageScore: 0,
    totalExpectedValue: 0,
    totalSuggestedListPrice: 0,
    totalRealisedRevenue: 0,
    totalRenewalCostPaid: 0,
    netProfit: 0,
    roiPct: 0,
    aggregateNpv: 0,
    aggregateProjectedAnnualReturn: 0,
    breakdownByVerdict: [],
    breakdownByTld: [],
    domainsAtRisk: [],
  };
}

function makeRoiReport(): RoiReport {
  return {
    generatedAt: new Date().toISOString(),
    totalDomains: 0,
    soldDomains: 0,
    holdingDomains: 0,
    droppedDomains: 0,
    totalAcquisitionCost: 0,
    totalRenewalCostPaid: 0,
    totalCost: 0,
    totalRevenue: 0,
    netProfit: 0,
    roiPct: 0,
    aggregateNpv: 0,
    domainDetails: [],
  };
}

function makeMockReportService(): PortfolioReportService {
  return {
    generate: vi.fn().mockResolvedValue(makeEmptyReport()),
    domainRoi: vi.fn(),
    allRoi: vi.fn().mockResolvedValue(makeRoiReport()),
  } as unknown as PortfolioReportService;
}

function captureOutput<T>(fn: () => T): Promise<string> {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const flush = (): string => {
    const lines: string[] = [];
    for (const call of logSpy.mock.calls) {
      lines.push(call.map(String).join(' '));
    }
    for (const call of errSpy.mock.calls) {
      lines.push(call.map(String).join(' '));
    }
    logSpy.mockRestore();
    errSpy.mockRestore();
    return lines.join('\n');
  };
  const result = fn();
  if (result instanceof Promise) {
    return result.then(flush, flush);
  }
  return Promise.resolve(flush());
}

describe('report CLI command', () => {
  let reportService: PortfolioReportService;

  beforeEach(() => {
    reportService = makeMockReportService();
  });

  it('report summary prints header when portfolio is empty', async () => {
    const program = new Command();
    program.exitOverride();
    registerReportCommand(program, { reportService });

    const reportCmd = program.commands.find((c) => c.name() === 'report');
    expect(reportCmd).toBeDefined();
    const summaryCmd = reportCmd!.commands.find((c) => c.name() === 'summary');
    expect(summaryCmd).toBeDefined();

    const generateSpy = vi.spyOn(reportService, 'generate');

    const output = await captureOutput(() =>
      program.parseAsync(['node', 'dominus', 'report', 'summary']),
    );

    expect(generateSpy).toHaveBeenCalled();
    expect(output).toContain('Portfolio Summary');
  });

  it('report tld prints breakdown header', async () => {
    const program = new Command();
    program.exitOverride();
    registerReportCommand(program, { reportService });

    const output = await captureOutput(() =>
      program.parseAsync(['node', 'dominus', 'report', 'tld']),
    );

    expect(output).toContain('TLD Breakdown');
  });

  it('report risk prints "No domains at risk" when empty', async () => {
    const program = new Command();
    program.exitOverride();
    registerReportCommand(program, { reportService });

    const output = await captureOutput(() =>
      program.parseAsync(['node', 'dominus', 'report', 'risk']),
    );

    expect(output).toContain('No domains at risk');
  });

  it('report risk lists domains when at-risk entries exist', async () => {
    const reportWithRisk = makeEmptyReport();
    reportWithRisk.domainsAtRisk = [
      {
        domain: 'expiring.com',
        daysUntilRenewal: 5,
        currentScore: 30,
        suggestedListPrice: 200,
        acquisitionCost: 10,
        renewalCost: 12,
        verdict: 'keep',
      },
      {
        domain: 'low-score.com',
        daysUntilRenewal: 45,
        currentScore: 15,
        suggestedListPrice: 100,
        acquisitionCost: 8,
        renewalCost: 10,
        verdict: 'keep',
      },
    ];
    const svc = {
      generate: vi.fn().mockResolvedValue(reportWithRisk),
      allRoi: vi.fn().mockResolvedValue(makeRoiReport()),
    } as unknown as PortfolioReportService;

    const program = new Command();
    program.exitOverride();
    registerReportCommand(program, { reportService: svc });

    const output = await captureOutput(() =>
      program.parseAsync(['node', 'dominus', 'report', 'risk']),
    );

    expect(output).toContain('Domain(s) at Risk');
    expect(output).toContain('expiring.com');
    expect(output).toContain('low-score.com');
  });

  it('report roi prints ROI header', async () => {
    const program = new Command();
    program.exitOverride();
    registerReportCommand(program, { reportService });

    const output = await captureOutput(() =>
      program.parseAsync(['node', 'dominus', 'report', 'roi']),
    );

    expect(output).toContain('Portfolio ROI');
  });

  it('report csv prints CSV header', async () => {
    const program = new Command();
    program.exitOverride();
    registerReportCommand(program, { reportService });

    const output = await captureOutput(() =>
      program.parseAsync(['node', 'dominus', 'report', 'csv']),
    );

    expect(output).toContain('domain,status,acquisition_cost');
  });
});
