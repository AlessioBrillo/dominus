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

export interface TldAccuracy {
  tld: string;
  sampleSize: number;
  mape: number;
  bias: number;
  meanPredicted: number;
  meanActual: number;
}

export interface AccuracyTrend {
  period: string;
  sampleSize: number;
  mape: number;
  f1: number;
}

export interface SignalAvailabilityAccuracy {
  signal: string;
  available: AccuracyMetrics;
  unavailable: AccuracyMetrics;
}

export interface AccuracyReport {
  generatedAt: string;
  sampleSize: number;
  overall: AccuracyMetrics;
  confusionMatrix: ConfusionMatrix;
  byTld: TldAccuracy[];
  calibration: Record<string, CalibrationBucketStat>;
  bySignalAvailability: SignalAvailabilityAccuracy[];
  trend: AccuracyTrend[];
  warnings: string[];
}

export type ConfidenceBucket = 'low' | 'mid' | 'high';

export interface CalibrationBucketStat {
  n: number;
  meanAbsError: number;
  meanRealised: number;
  meanPredicted: number;
}

export const CONFIDENCE_BUCKETS: readonly ConfidenceBucket[] = ['low', 'mid', 'high'] as const;

export function bucketForConfidence(confidence: number): ConfidenceBucket {
  if (confidence < 0.3) return 'low';
  if (confidence < 0.6) return 'mid';
  return 'high';
}

export interface OutcomeAccuracyScore {
  domain: string;
  outcomeType: string;
  recommended: boolean;
  weightedScore: number;
  confidence: number;
  expectedValue: number;
  actualSalePrice: number | null;
  tld: string;
  scoredAt: string;
  occurredAt: string;
  commercialScore: number;
  marketScore: number;
  expiryScore: number;
}

export interface AccuracyReportSnapshot {
  scanned: number;
  included: number;
  skippedNoScore: number;
  skippedNoOutcome: number;
}

export type PeriodGranularity = 'monthly' | 'quarterly';
