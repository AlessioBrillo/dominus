import type { ConfidenceBucket } from '../../db/repositories/backtest-signals-repository.js';

export { type ConfidenceBucket } from '../../db/repositories/backtest-signals-repository.js';

export interface CalibrationBucketStat {
  n: number;
  meanAbsError: number;
  meanRealised: number;
  meanPredicted: number;
}

export interface BacktestReport {
  generatedAt: string;
  sampleSize: number;
  excludedNoPrediction: number;
  excludedNoOutcome: number;
  meanAbsoluteErrorEur: number;
  medianAbsoluteErrorEur: number;
  biasEur: number;
  biasPct: number;
  buyMaxMeanAbsoluteErrorEur: number;
  buyMaxHitRate: number;
  calibration: Record<ConfidenceBucket, CalibrationBucketStat>;
}

export interface SnapshotSummary {
  scanned: number;
  inserted: number;
  skipped: number;
}
