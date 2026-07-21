export interface FunnelConfig {
  budgetEur: number;
  minConfidence: number;
  minBuyMaxEur: number;
  maxEntries: number;
}

export interface FunnelEntry {
  id?: number;
  runId: string;
  domain: string;
  tld: string;
  source: string;
  priorityScore: number;
  budgetAllocationEur: number;
  expectedReturnEur: number;
  expectedValue: number;
  confidence: number;
  suggestedBuyMax: number;
  suggestedListPrice: number;
  trademarkClear: boolean;
  status: 'pending' | 'acquired' | 'passed';
  createdAt?: string;
}

export interface FunnelBreakdown {
  totalCandidates: number;
  passedFilters: number;
  budgetUsedEur: number;
  budgetRemainingEur: number;
  totalExpectedReturnEur: number;
  expectedRoi: number;
  averageConfidence: number;
}

export interface FunnelResult {
  runId: string;
  generatedAt: string;
  config: FunnelConfig;
  entries: FunnelEntry[];
  breakdown: FunnelBreakdown;
}
