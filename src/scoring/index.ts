export { ScoringEngine } from './scoring-engine.js';
export {
  DEFAULT_WEIGHTS,
  CONFIDENCE_THRESHOLD,
  WEIGHT_RECOMMEND_THRESHOLD,
  DEFAULT_TLD_BONUS,
} from './weights.js';
export type { ScoringWeights } from './weights.js';
export { loadWeights, WeightsOverrideError } from './weights-loader.js';
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
