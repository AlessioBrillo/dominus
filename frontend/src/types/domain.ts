export interface ScoreResult {
  domain: string;
  expectedValue: number;
  confidence: number;
  suggestedBuyMax: number;
  suggestedListPrice: number;
  bidRange: {
    conservative: number;
    aggressive: number;
  };
  weightedScore: number;
  recommended: boolean;
  scoredAt: string;
  breakdown: {
    intrinsic: { score: number; weight: number };
    commercial: { score: number; weight: number };
    market: { score: number; weight: number };
    expiry: { score: number; weight: number };
  };
}

export interface Candidate {
  id: number;
  domain: string;
  tld: string;
  source: string;
  status: string;
  pipelineRunId?: string;
  scoreResult?: ScoreResult | null;
  createdAt: string;
}

export interface PortfolioEntry {
  id: number;
  domain: string;
  tld: string;
  acquiredAt: string;
  renewalDate: string;
  acquisitionCost: number;
  renewalCost: number;
  registrar: string;
  currentScore?: number;
  suggestedListPrice?: number;
  verdict: string;
  verdictReason?: string;
  notes?: string;
}

export interface Outcome {
  id: number;
  domain: string;
  type: 'sold' | 'dropped' | 'expired' | 'renewed';
  occurredAt: string;
  salePriceEur?: number;
  listingPriceEur?: number;
  daysListed?: number;
  venue?: string;
  commissionPct?: number;
  notes?: string;
}

export interface PipelineRun {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  totalDurationMs?: number;
  stageSummary: Record<string, { passed: number; filtered: number; durationMs: number }>;
  resultsSummary: Record<string, unknown>;
}

export interface Alert {
  id: number;
  domain: string;
  alertType: string;
  severity: string;
  message: string;
  acknowledgedAt?: string;
  createdAt: string;
}

export interface Bid {
  id?: number;
  domain: string;
  venue: string;
  bidAmountEur: number;
  maxBidEur?: number;
  status: string;
  wonPriceEur?: number;
  expectedValueAtBid?: number;
  confidenceAtBid?: number;
  suggestedBuyMaxAtBid?: number;
  trademarkClearAtBid?: boolean;
  bidPlacedAt: string;
  auctionEndsAt?: string;
  resolvedAt?: string;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProviderStatus {
  name: string;
  configured: boolean;
  note: string;
}

export interface HealthResponse {
  status: string;
  uptime: number;
  version: string;
  timestamp: string;
}
