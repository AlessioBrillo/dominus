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

export const CONFIDENCE_THRESHOLD = 0.3;

/**
 * Minimum weightedScore for a candidate to be recommended.
 * Hardcoded at 0.4 for MVP; the operator can adjust via the
 * SCORING_RECOMMEND_THRESHOLD env variable (in a later commit).
 */
export const WEIGHT_RECOMMEND_THRESHOLD = 0.4;

export const PREMIUM_TLD_BONUS: Record<string, number> = {
  '.com': 1.0,
  '.io': 0.85,
  '.ai': 0.9,
  '.co': 0.75,
  '.net': 0.65,
  '.org': 0.55,
};
