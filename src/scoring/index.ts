export { ScoringEngine } from './scoring-engine.js';
export { DEFAULT_WEIGHTS, CONFIDENCE_THRESHOLD, PREMIUM_TLD_BONUS } from './weights.js';
export type { ScoringWeights } from './weights.js';
export { computeIntrinsicScore } from './signals/intrinsic-signal.js';
export { computeCommercialScore } from './signals/commercial-signal.js';
export { computeMarketScore } from './signals/market-signal.js';
export { computeExpiryScore } from './signals/expiry-signal.js';
