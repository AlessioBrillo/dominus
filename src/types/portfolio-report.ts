export interface TldBreakdown {
  tld: string;
  count: number;
  totalAcquisitionCost: number;
  totalAnnualRenewalCost: number;
  totalExpectedValue: number;
}

export interface VerdictBreakdown {
  verdict: string;
  count: number;
  totalExpectedValue: number;
  totalAcquisitionCost: number;
}

export interface DomainRiskItem {
  domain: string;
  daysUntilRenewal: number;
  currentScore: number | undefined;
  suggestedListPrice: number | undefined;
  acquisitionCost: number;
  renewalCost: number;
  verdict: string;
}

export interface DomainFinancialProjection {
  domain: string;
  expectedValue: number;
  confidence: number;
  acquisitionCost: number;
  renewalCost: number;
  /** Net Present Value of holding: sum(expectedValue * confidence / (1+r)^t - renewalCost / (1+r)^t) over horizon */
  npv: number;
  /** Annual renewal burn rate */
  annualRenewalCost: number;
  /** Projected annual return (EV * confidence / holdingYears - renewalCost) */
  projectedAnnualReturn: number;
  /** Expected recovery: how many years of renewal costs the expected value covers */
  breakEvenYears: number;
}

export interface DomainRoi {
  domain: string;
  acquisitionCost: number;
  totalRenewalCostPaid: number;
  totalCost: number;
  salePriceEur: number | undefined;
  grossProfit: number;
  netProfit: number;
  roiPct: number;
  status: 'sold' | 'holding' | 'dropped' | 'expired';
  daysHeld: number;
  npv?: number | undefined;
  projectedAnnualReturn?: number | undefined;
}

export interface PortfolioReport {
  generatedAt: string;
  totalDomains: number;
  totalAcquisitionCost: number;
  totalAnnualRenewalCost: number;
  monthlyBurnRate: number;
  domainsWithScore: number;
  domainsWithListPrice: number;
  averageScore: number;
  totalExpectedValue: number;
  totalSuggestedListPrice: number;
  totalRealisedRevenue: number;
  totalRenewalCostPaid: number;
  netProfit: number;
  roiPct: number;
  /** Aggregate NPV of all scored domains in the portfolio */
  aggregateNpv: number;
  /** Total projected annual return across all domains */
  aggregateProjectedAnnualReturn: number;
  breakdownByVerdict: VerdictBreakdown[];
  breakdownByTld: TldBreakdown[];
  domainsAtRisk: DomainRiskItem[];
}

export interface RoiReport {
  generatedAt: string;
  totalDomains: number;
  soldDomains: number;
  holdingDomains: number;
  droppedDomains: number;
  totalAcquisitionCost: number;
  totalRenewalCostPaid: number;
  totalCost: number;
  totalRevenue: number;
  netProfit: number;
  roiPct: number;
  aggregateNpv: number;
  domainDetails: DomainRoi[];
}
