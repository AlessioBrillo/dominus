// SPDX-License-Identifier: AGPL-3.0-only
export interface ScoringWeights {
  intrinsic: number;
  commercial: number;
  market: number;
  expiry: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  intrinsic: 0.3,
  commercial: 0.35,
  market: 0.25,
  expiry: 0.1,
};

export const WEIGHT_RECOMMEND_THRESHOLD = 0.4;

/**
 * Minimum proportion of total weight that must have live data before
 * we use the default weights as-is. Below this threshold, weights are
 * redistributed to available signals via resolveEffectiveWeights().
 * Value: 0.70 — when 70%+ of signals have data, use defaults.
 */
export const SIGNAL_DATA_THRESHOLD = 0.7;

/**
 * Fallback weights used as redistribution ratios when signals are
 * unavailable. These represent the relative importance of each
 * signal in a data-sparse scenario:
 *   - intrinsic (0.60): name quality is always observable
 *   - expiry (0.40): domain age/backlinks are valuable when available
 *
 * Commercial and market are excluded from fallback because both
 * require external provider data which may not exist in a zero-cost
 * setup. When unavailable, their weight is redistributed to intrinsic
 * and expiry proportionally to these ratios.
 */
export const DEFAULT_FALLBACK_WEIGHTS: ScoringWeights = {
  intrinsic: 0.6,
  commercial: 0,
  market: 0,
  expiry: 0.4,
};

/**
 * Floor for effectiveRecommendThreshold. Even with zero signal data,
 * a minimum threshold prevents recommending domains with trivial
 * intrinsic scores. Value: 0.20, which requires intrinsicScore >= 0.20
 * (a very low bar but better than no floor).
 */
export const MIN_EFFECTIVE_RECOMMEND_THRESHOLD = 0.2;

/**
 * Floor for effectiveConfidenceThreshold. Prevents recommending domains
 * with trivial confidence even in data-sparse scenarios.
 */
export const MIN_EFFECTIVE_CONFIDENCE_THRESHOLD = 0.18;

/**
 * Ceiling for effectiveConfidenceThreshold. When all signals have data,
 * the threshold rises to this value. Together with MIN_* the effective
 * threshold ranges in [0.18, 0.30], matching the engine's confidence
 * base/cap of [0.2, 0.8] with a buffer.
 */
export const MAX_EFFECTIVE_CONFIDENCE_THRESHOLD = 0.3;

/**
 * Multiplier applied to the intrinsic quality score by TLD. Calibrated
 * conservatively on aftermarket liquidity/value; unknowns get the floor
 * multiplier (0.45) rather than being structurally unrecommendable:
 * the signalled gTLDs (.xyz, .app, .dev, ...) dominate closeout pipelines
 * and a hard 0.3 penalty made them un-enterable in data-sparse runs.
 */
export const DEFAULT_TLD_BONUS: Record<string, number> = {
  '.com': 1.0,
  '.ai': 0.9,
  '.io': 0.85,
  '.co': 0.75,
  '.net': 0.65,
  '.org': 0.55,
  '.app': 0.5,
  '.dev': 0.5,
  '.tv': 0.5,
  '.me': 0.45,
  '.us': 0.45,
  '.tech': 0.45,
  '.xyz': 0.45,
  '.shop': 0.4,
  '.site': 0.4,
  '.online': 0.4,
  '.store': 0.4,
};

/**
 * Multiplier for TLDs not present in the bonus map. Raised from 0.3 to
 * 0.45 so unknown gTLDs stay penalised (vs .com) without becoming
 * unrecommendable in data-sparse runs: intrinsic 0.45 × fallback weight
 * 0.6 = 0.27 ≥ MIN_EFFECTIVE_RECOMMEND_THRESHOLD (0.2).
 */
export const UNKNOWN_TLD_MULTIPLIER = 0.45;
