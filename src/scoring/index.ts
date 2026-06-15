export { ScoringEngine } from './scoring-engine.js';
export {
  DEFAULT_WEIGHTS,
  WEIGHT_RECOMMEND_THRESHOLD,
  DEFAULT_TLD_BONUS,
  DEFAULT_FALLBACK_WEIGHTS,
  SIGNAL_DATA_THRESHOLD,
  MIN_EFFECTIVE_RECOMMEND_THRESHOLD,
  MIN_EFFECTIVE_CONFIDENCE_THRESHOLD,
} from './weights.js';
export type { ScoringWeights } from './weights.js';
export {
  loadWeights,
  reloadWeights,
  WeightsOverrideError,
  resolveEffectiveWeights,
  computeEffectiveThresholds,
} from './weights-loader.js';
export { loadTldBonuses } from './tld-bonus-loader.js';
export {
  DEFAULT_SCORING_CONFIG,
  DEFAULT_INTRINSIC_CONFIG,
  DEFAULT_COMMERCIAL_CONFIG,
  DEFAULT_MARKET_CONFIG,
  DEFAULT_EXPIRY_CONFIG,
  DEFAULT_SCORING_CONSTANTS,
} from './scoring-config.js';
export type {
  ScoringConfig,
  IntrinsicSignalConfig,
  CommercialSignalConfig,
  MarketSignalConfig,
  ExpirySignalConfig,
  ScoringConstants,
} from './scoring-config.js';
export { computeIntrinsicScore } from './signals/intrinsic-signal.js';
export { computeCommercialScore } from './signals/commercial-signal.js';
export { computeMarketScore } from './signals/market-signal.js';
export { computeExpiryScore } from './signals/expiry-signal.js';
export { AutoWeightTuner } from './auto-tuner.js';
export type { AutoTuneOutcome } from './auto-tuner.js';
export { DEFAULT_AUTO_TUNER_CONFIG } from './auto-tuner-config.js';
export type { AutoTunerConfig } from './auto-tuner-config.js';
