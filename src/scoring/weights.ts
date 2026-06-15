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

export const DEFAULT_TLD_BONUS: Record<string, number> = {
  '.com': 1.0,
  '.io': 0.85,
  '.ai': 0.9,
  '.co': 0.75,
  '.net': 0.65,
  '.org': 0.55,
};
