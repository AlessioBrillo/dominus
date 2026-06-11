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
  domainDetails: DomainRoi[];
}
