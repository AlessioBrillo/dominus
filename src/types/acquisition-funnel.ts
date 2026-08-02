// SPDX-License-Identifier: AGPL-3.0-only
export interface FunnelConfig {
  budgetEur: number;
  minConfidence: number;
  minBuyMaxEur: number;
  maxEntries: number;
  /** Fraction of the Kelly-optimal allocation to apply.
   *  1.0 = full Kelly (optimal growth), 0.5 = half Kelly (conservative),
   *  0.25 = quarter Kelly (very conservative). Default: 0.5.
   *  Set to 0 to fall back to the legacy greedy allocator. */
  kellyFraction?: number | undefined;
  /** Maximum percentage of the total budget that can be allocated
   *  to a single domain (0-1). Prevents concentration risk.
   *  Default: 0.3 (30%). */
  maxConcentrationPct?: number | undefined;
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
