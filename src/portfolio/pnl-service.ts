// SPDX-License-Identifier: AGPL-3.0-only
import type { PortfolioRepository } from '../db/repositories/portfolio-repository.js';
import type { Outcome } from '../types/outcome.js';

export interface PnlSummary {
  totalInvestmentEur: number;
  totalReturnsEur: number;
  netPnlEur: number;
  roiPct: number;
  holdingCostsEur: number;
  soldCount: number;
  totalCount: number;
}

export interface PnlPerDomain {
  domain: string;
  tld: string;
  acquisitionCostEur: number;
  renewalCostsPaidEur: number;
  totalCostEur: number;
  salePriceEur: number | undefined;
  netPnlEur: number;
  holdingDays: number;
  verdict: string;
}

export interface PnlMonthlyTrend {
  period: string;
  investmentEur: number;
  returnsEur: number;
  netFlowEur: number;
}

export interface PnlReport {
  generatedAt: string;
  summary: PnlSummary;
  perDomain: PnlPerDomain[];
  monthlyTrend: PnlMonthlyTrend[];
}

/**
 * Where the outcomes come from.
 *
 * A loader is the only correct choice in a multi-tenant deployment: the
 * outcomes of the 'default' tenant (or of no tenant at all) captured at
 * boot time are not the outcomes of the customer who asks for the report.
 */
export type OutcomeSource = Outcome[] | (() => Promise<Outcome[]>);

export class PnlService {
  constructor(
    private readonly portfolioRepo: PortfolioRepository,
    private readonly outcomes: OutcomeSource,
  ) {}

  static async create(
    portfolioRepo: PortfolioRepository,
    outcomes: OutcomeSource,
  ): Promise<PnlService> {
    return new PnlService(portfolioRepo, outcomes);
  }

  /** The outcomes of the tenant of the current request. */
  private async getOutcomes(): Promise<Outcome[]> {
    return typeof this.outcomes === 'function' ? await this.outcomes() : this.outcomes;
  }

  private getSoldOutcomes(outcomes: Outcome[]): Outcome[] {
    return outcomes.filter((o) => o.type === 'sold');
  }

  async generate(): Promise<PnlReport> {
    const allEntries = await this.portfolioRepo.findAll();
    const outcomes = await this.getOutcomes();
    const soldOutcomes = this.getSoldOutcomes(outcomes);

    const totalInvestment = allEntries.reduce((sum, e) => sum + e.acquisitionCost, 0);
    const totalReturns = soldOutcomes.reduce((sum, o) => sum + (o.salePriceEur ?? 0), 0);
    const holdingCosts = allEntries.reduce((sum, e) => sum + e.renewalCost, 0);

    const netPnl = totalReturns - totalInvestment - holdingCosts;
    const denominator = totalInvestment + holdingCosts;
    const roiPct = denominator > 0 ? (netPnl / denominator) * 100 : 0;

    const perDomain: PnlPerDomain[] = allEntries.map((entry) => {
      const domainOutcomes = outcomes.filter((o) => o.domain === entry.domain);
      const sold = domainOutcomes.find((o) => o.type === 'sold');

      const acquisitionCost = entry.acquisitionCost;
      const renewalCostsPaid = entry.renewalCost;
      const totalCost = acquisitionCost + renewalCostsPaid;
      const salePrice = sold?.salePriceEur;
      const netDomainPnl = (salePrice ?? 0) - totalCost;

      const acquiredAt = new Date(entry.acquiredAt).getTime();
      const now = Date.now();
      const holdingDays = Math.max(1, Math.round((now - acquiredAt) / (1000 * 60 * 60 * 24)));

      return {
        domain: entry.domain,
        tld: entry.tld,
        acquisitionCostEur: acquisitionCost,
        renewalCostsPaidEur: renewalCostsPaid,
        totalCostEur: totalCost,
        salePriceEur: salePrice,
        netPnlEur: netDomainPnl,
        holdingDays,
        verdict: entry.verdict,
      };
    });

    perDomain.sort((a, b) => b.netPnlEur - a.netPnlEur);

    const monthlyTrend = this.#computeMonthlyTrend(allEntries, soldOutcomes);

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        totalInvestmentEur: totalInvestment,
        totalReturnsEur: totalReturns,
        netPnlEur: netPnl,
        roiPct,
        holdingCostsEur: holdingCosts,
        soldCount: soldOutcomes.length,
        totalCount: allEntries.length,
      },
      perDomain,
      monthlyTrend,
    };
  }

  #computeMonthlyTrend(
    entries: Array<{ domain: string; acquiredAt: string; acquisitionCost: number }>,
    sold: Outcome[],
  ): PnlMonthlyTrend[] {
    const byPeriod = new Map<string, { investment: number; returns: number }>();

    for (const e of entries) {
      const d = new Date(e.acquiredAt);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const existing = byPeriod.get(period) ?? { investment: 0, returns: 0 };
      existing.investment += e.acquisitionCost;
      byPeriod.set(period, existing);
    }

    for (const o of sold) {
      const d = new Date(o.occurredAt);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const existing = byPeriod.get(period) ?? { investment: 0, returns: 0 };
      existing.returns += o.salePriceEur ?? 0;
      byPeriod.set(period, existing);
    }

    const sortedPeriods = [...byPeriod.keys()].sort();
    return sortedPeriods.map((period) => {
      const data = byPeriod.get(period)!;
      return {
        period,
        investmentEur: data.investment,
        returnsEur: data.returns,
        netFlowEur: data.returns - data.investment,
      };
    });
  }
}
