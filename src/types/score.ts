export interface SignalStatusItem {
  name: string;
  available: boolean;
  error?: string | undefined;
}

export interface SignalOutput {
  score: number;
  weight: number;
  details: Record<string, unknown>;
  /**
   * When true, the signal was computed from real provider data.
   * When false, the signal fell back to default (zero) because
   * the provider was unavailable, returned no data, or the
   * input had no relevant data for this signal type.
   */
  dataAvailable?: boolean | undefined;
  /**
   * When set, the provider call failed and the signal was computed
   * with fallback values. The error message is captured for
   * observability but never blocks scoring.
   */
  providerError?: string | undefined;
}

export interface ScoreBreakdown {
  intrinsic: SignalOutput;
  commercial: SignalOutput;
  market: SignalOutput;
  expiry: SignalOutput;
}

export interface ScoreResult {
  candidateId?: number | undefined;
  domain: string;
  expectedValue: number;
  confidence: number;
  suggestedBuyMax: number;
  suggestedListPrice: number;
  /**
   * Bid range advises a conservative floor and an aggressive ceiling
   * for aftermarket negotiation. Both values are REALISTIC bids, not
   * aspirational — they are bounded by BUY_MAX_ABSOLUTE_CAP but also
   * reflect that the cap flattens the market signal above ~€500.
   *
   * - `conservative`: the price at which the deal is an unambiguous
   *   bargain (≈ buyMax at 50% confidence).
   * - `aggressive`: the maximum justifiable bid (≈ buyMax at full
   *   confidence).
   *
   * Both are clamped to [0, buyMaxAbsoluteCap]. When the cap is hit,
   * aggressive equals the cap and conservative trails proportionally
   * to confidence/cap ratio.
   */
  bidRange: {
    conservative: number;
    aggressive: number;
  };
  /**
   * Weighted average of all four signal scores, clamped to [0, 1].
   * This is the engine's "raw" verdict before EUR scaling. The portfolio
   * layer projects it onto a 0-100 calibrated scale
   * (`currentScore = round(weightedScore * 100)`) so verdicts and the
   * drop threshold can talk the same units.
   */
  weightedScore: number;
  breakdown: ScoreBreakdown;
  recommended: boolean;
  scoredAt: string;
  signalStatus: SignalStatusItem[];
}

export interface ScoringInput {
  domain: string;
  /**
   * Top-level label including the leading dot (e.g. `.com`, `.co.uk`).
   * When absent, the scoring engine computes it internally via the
   * authoritative PSL-based domain parser. All internal callers
   * should omit this and let the engine derive both tld and sld
   * from `domain` — this guarantees consistency across all consumers.
   */
  tld?: string | undefined;
  /**
   * Canonical second-level label. When provided, the scoring engine
   * uses it directly. When absent (undefined), the engine computes it
   * internally via `parseDomain(domain).sld` — this is the preferred
   * path because it guarantees the SLD is always derived from the
   * authoritative domain parser (PSL-based).
   *
   * The field is kept for backward compatibility with any external
   * caller that pre-computes the SLD, but all internal callers
   * should omit it and let the engine derive it.
   */
  sld?: string | undefined;
  isCloseout: boolean;
  domainAge?: number | undefined;
  backlinks?: number | undefined;
  waybackSnapshots?: number | undefined;
  /**
   * Annual renewal cost in EUR. When provided, the scoring engine
   * subtracts `renewalCost × holdingYears` from the raw buy-max
   * before applying the absolute cap. This prevents recommending
   * domains whose renewal costs erode the expected profit.
   * Default: no penalty (undefined).
   */
  renewalCost?: number | undefined;
}
