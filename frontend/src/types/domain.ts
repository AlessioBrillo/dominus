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
  salePriceEur?: number;
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

export interface AccuracyMetrics {
  mape: number;
  medianApe: number;
  mae: number;
  rmse: number;
  bias: number;
  biasPct: number;
  sampleSize: number;
}

export interface ConfusionMatrix {
  truePositives: number;
  falsePositives: number;
  trueNegatives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface CalibrationBucketStat {
  n: number;
  meanAbsError: number;
  meanRealised: number;
  meanPredicted: number;
}

export interface AccuracyReport {
  generatedAt: string;
  sampleSize: number;
  overall: AccuracyMetrics;
  confusionMatrix: ConfusionMatrix;
  calibration: Record<string, CalibrationBucketStat>;
  warnings: string[];
}

export type ListingStatus =
  'draft' | 'listed' | 'offer_received' | 'sold' | 'expired' | 'unlisted' | 'pending' | 'paused';

export type MarketplaceName = 'dan' | 'afternic' | 'sedo' | 'godaddy' | 'manual';

export interface Listing {
  id: number;
  domain: string;
  marketplace: MarketplaceName;
  listingUrl: string | null;
  priceEur: number;
  status: ListingStatus;
  scoringSnapshotJson: string | null;
  listedAt: string | null;
  expiresAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListingOffer {
  id: number;
  listingId: number;
  amountEur: number;
  buyer: string;
  status: string;
  receivedAt: string;
  respondedAt: string | null;
  notes: string | null;
}
