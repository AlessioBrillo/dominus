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
  warnings: string[];
}

export interface DomainCostInfo {
  acquisitionCostEur: number;
  totalRenewalCostPaidEur: number;
}

export interface SnapshotSummary {
  scanned: number;
  inserted: number;
  skipped: number;
}

/**
 * Per-signal scores recovered from a `scoring_runs` row. The weight
 * suggester (ADR-0009) compares these against realised sale prices to
 * decide whether a signal is predictive and should carry more (or less)
 * weight in the next calibration round.
 */
export interface SignalScores {
  intrinsic: number;
  commercial: number;
  market: number;
  expiry: number;
}

export type SignalName = keyof SignalScores;

export const SIGNAL_NAMES: readonly SignalName[] = [
  'intrinsic',
  'commercial',
  'market',
  'expiry',
] as const;

export function isSignalName(value: string): value is SignalName {
  return (SIGNAL_NAMES as readonly string[]).includes(value);
}

export interface SignalPredictiveness {
  signal: SignalName;
  /** Realised EUR mean among domains with score >= HIGH_THRESHOLD. */
  highMeanRealised: number;
  highN: number;
  /** Realised EUR mean among domains with score < HIGH_THRESHOLD. */
  lowMeanRealised: number;
  lowN: number;
  /** high - low. Positive = signal predicts higher sales. */
  lift: number;
}

export interface WeightSuggestion {
  signal: SignalName;
  currentWeight: number;
  suggestedWeight: number;
  delta: number;
  /** 'apply' if the suggester has enough evidence to recommend a change,
   *  'hold' if the data is too thin or the lift is too small to be sure,
   *  'revert' if the lift is negative and we recommend pulling weight. */
  action: 'apply' | 'hold' | 'revert';
  rationale: string;
}

export interface WeightSuggestionReport {
  generatedAt: string;
  sampleSize: number;
  totalCurrentWeight: number;
  totalSuggestedWeight: number;
  suggestions: WeightSuggestion[];
  /** True if the suggested weights still sum to 1.0 within tolerance. */
  sumsToOne: boolean;
  warnings: string[];
}
