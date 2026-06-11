import type { PortfolioRepository } from '../db/repositories/portfolio-repository.js';
import type { OutcomeRepository } from '../db/repositories/outcome-repository.js';
import type {
  PortfolioReport,
  DomainRoi,
  RoiReport,
  TldBreakdown,
  VerdictBreakdown,
  DomainRiskItem,
} from '../types/portfolio-report.js';
import { computeRenewalClock } from './renewal-clock.js';

export class PortfolioReportService {
  constructor(
    private readonly portfolioRepo: PortfolioRepository,
    private readonly outcomeRepo: OutcomeRepository,
    private readonly dropScoreThreshold: number = 25,
    private readonly renewalWarningDays: number = 30,
  ) {}

  async generate(): Promise<PortfolioReport> {
    const entries = this.portfolioRepo.findAll();
    const totalDomains = entries.length;

    if (totalDomains === 0) {
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
        breakdownByVerdict: [],
        breakdownByTld: [],
        domainsAtRisk: [],
      };
    }

    const totalAcquisitionCost = entries.reduce((s, e) => s + e.acquisitionCost, 0);
    const totalAnnualRenewalCost = entries.reduce((s, e) => s + e.renewalCost, 0);
    const scored = entries.filter((e) => e.currentScore !== undefined);
    const withListPrice = entries.filter((e) => e.suggestedListPrice !== undefined);
    const averageScore =
      scored.length > 0 ? scored.reduce((s, e) => s + (e.currentScore ?? 0), 0) / scored.length : 0;

    const totalExpectedValue = scored.reduce(
      (s, e) =>
        s + ((e.currentScore ?? 0) / 100) * 500 * (1 + ((e.suggestedListPrice ?? 0) / 500) * 0.5),
      0,
    );
    const totalSuggestedListPrice = withListPrice.reduce(
      (s, e) => s + (e.suggestedListPrice ?? 0),
      0,
    );

    const soldOutcomes = this.outcomeRepo.findByType('sold');
    const totalRealisedRevenue = soldOutcomes.reduce((s, o) => s + (o.salePriceEur ?? 0), 0);

    const totalOutcomes = this.outcomeRepo.findAll();
    const totalRenewalCostPaid = entries.reduce((s, e) => {
      const renewals = totalOutcomes.filter(
        (o) => o.domain === e.domain && o.type === 'renewed',
      ).length;
      return s + renewals * e.renewalCost;
    }, 0);

    const netProfit = totalRealisedRevenue - totalAcquisitionCost - totalRenewalCostPaid;
    const totalCost = totalAcquisitionCost + totalRenewalCostPaid;
    const roiPct = totalCost > 0 ? (netProfit / totalCost) * 100 : 0;

    const verdictMap = new Map<string, { count: number; totalValue: number; totalCost: number }>();
    for (const e of entries) {
      const v = e.verdict;
      const current = verdictMap.get(v) ?? { count: 0, totalValue: 0, totalCost: 0 };
      current.count++;
      current.totalValue += e.suggestedListPrice ?? 0;
      current.totalCost += e.acquisitionCost;
      verdictMap.set(v, current);
    }
    const breakdownByVerdict: VerdictBreakdown[] = Array.from(verdictMap.entries()).map(
      ([verdict, data]) => ({
        verdict,
        count: data.count,
        totalExpectedValue: data.totalValue,
        totalAcquisitionCost: data.totalCost,
      }),
    );

    const tldMap = new Map<string, { count: number; acq: number; renew: number; value: number }>();
    for (const e of entries) {
      const current = tldMap.get(e.tld) ?? { count: 0, acq: 0, renew: 0, value: 0 };
      current.count++;
      current.acq += e.acquisitionCost;
      current.renew += e.renewalCost;
      current.value += e.suggestedListPrice ?? 0;
      tldMap.set(e.tld, current);
    }
    const breakdownByTld: TldBreakdown[] = Array.from(tldMap.entries())
      .map(([tld, data]) => ({
        tld,
        count: data.count,
        totalAcquisitionCost: data.acq,
        totalAnnualRenewalCost: data.renew,
        totalExpectedValue: data.value,
      }))
      .sort((a, b) => b.count - a.count);

    const domainsAtRisk: DomainRiskItem[] = entries
      .map((e) => {
        const clock = computeRenewalClock(e);
        return {
          domain: e.domain,
          daysUntilRenewal: clock.daysUntilRenewal,
          currentScore: e.currentScore,
          suggestedListPrice: e.suggestedListPrice,
          acquisitionCost: e.acquisitionCost,
          renewalCost: e.renewalCost,
          verdict: e.verdict,
        };
      })
      .filter(
        (r) =>
          r.daysUntilRenewal <= this.renewalWarningDays ||
          (r.currentScore !== undefined && r.currentScore < this.dropScoreThreshold),
      )
      .sort((a, b) => a.daysUntilRenewal - b.daysUntilRenewal);

    return {
      generatedAt: new Date().toISOString(),
      totalDomains,
      totalAcquisitionCost,
      totalAnnualRenewalCost,
      monthlyBurnRate: +(totalAnnualRenewalCost / 12).toFixed(2),
      domainsWithScore: scored.length,
      domainsWithListPrice: withListPrice.length,
      averageScore: +averageScore.toFixed(2),
      totalExpectedValue: +totalExpectedValue.toFixed(2),
      totalSuggestedListPrice: +totalSuggestedListPrice.toFixed(2),
      totalRealisedRevenue: +totalRealisedRevenue.toFixed(2),
      totalRenewalCostPaid: +totalRenewalCostPaid.toFixed(2),
      netProfit: +netProfit.toFixed(2),
      roiPct: +roiPct.toFixed(2),
      breakdownByVerdict,
      breakdownByTld,
      domainsAtRisk,
    };
  }

  async domainRoi(domain: string): Promise<DomainRoi | null> {
    const entry = this.portfolioRepo.findByDomain(domain);
    if (!entry) return null;

    const outcomes = this.outcomeRepo.findByDomain(domain);
    const soldOutcome = outcomes.find((o) => o.type === 'sold');
    const dropOutcome = outcomes.find((o) => o.type === 'dropped');
    const expiredOutcome = outcomes.find((o) => o.type === 'expired');
    const renewalCount = outcomes.filter((o) => o.type === 'renewed').length;

    const totalRenewalCostPaid = renewalCount * entry.renewalCost;
    const totalCost = entry.acquisitionCost + totalRenewalCostPaid;

    const daysHeld = entry.acquiredAt
      ? Math.max(1, Math.floor((Date.now() - new Date(entry.acquiredAt).getTime()) / 86_400_000))
      : 1;

    if (soldOutcome) {
      const salePrice = soldOutcome.salePriceEur ?? 0;
      return {
        domain,
        acquisitionCost: entry.acquisitionCost,
        totalRenewalCostPaid,
        totalCost,
        salePriceEur: salePrice,
        grossProfit: salePrice - entry.acquisitionCost,
        netProfit: salePrice - totalCost,
        roiPct: totalCost > 0 ? +(((salePrice - totalCost) / totalCost) * 100).toFixed(2) : 0,
        status: 'sold',
        daysHeld: Math.max(
          1,
          Math.floor(
            (new Date(soldOutcome.occurredAt).getTime() - new Date(entry.acquiredAt).getTime()) /
              86_400_000,
          ),
        ),
      };
    }

    if (dropOutcome || expiredOutcome) {
      return {
        domain,
        acquisitionCost: entry.acquisitionCost,
        totalRenewalCostPaid,
        totalCost,
        salePriceEur: undefined,
        grossProfit: -entry.acquisitionCost,
        netProfit: -totalCost,
        roiPct: -100,
        status: dropOutcome ? 'dropped' : 'expired',
        daysHeld,
      };
    }

    return {
      domain,
      acquisitionCost: entry.acquisitionCost,
      totalRenewalCostPaid,
      totalCost,
      salePriceEur: undefined,
      grossProfit: -entry.acquisitionCost,
      netProfit: -totalCost,
      roiPct: -100,
      status: 'holding',
      daysHeld,
    };
  }

  async allRoi(): Promise<RoiReport> {
    const entries = this.portfolioRepo.findAll();
    const domainDetails: DomainRoi[] = [];

    for (const entry of entries) {
      const roi = await this.domainRoi(entry.domain);
      if (roi) domainDetails.push(roi);
    }

    const soldDomains = domainDetails.filter((d) => d.status === 'sold');
    const holdingDomains = domainDetails.filter((d) => d.status === 'holding');
    const droppedDomains = domainDetails.filter(
      (d) => d.status === 'dropped' || d.status === 'expired',
    );

    const totalAcquisitionCost = domainDetails.reduce((s, d) => s + d.acquisitionCost, 0);
    const totalRenewalCostPaid = domainDetails.reduce((s, d) => s + d.totalRenewalCostPaid, 0);
    const totalCost = totalAcquisitionCost + totalRenewalCostPaid;
    const totalRevenue = soldDomains.reduce((s, d) => s + (d.salePriceEur ?? 0), 0);
    const netProfit = totalRevenue - totalCost;
    const roiPct = totalCost > 0 ? +((netProfit / totalCost) * 100).toFixed(2) : 0;

    return {
      generatedAt: new Date().toISOString(),
      totalDomains: entries.length,
      soldDomains: soldDomains.length,
      holdingDomains: holdingDomains.length,
      droppedDomains: droppedDomains.length,
      totalAcquisitionCost,
      totalRenewalCostPaid,
      totalCost,
      totalRevenue,
      netProfit,
      roiPct,
      domainDetails: domainDetails.sort((a, b) => a.roiPct - b.roiPct),
    };
  }
}
