export interface SignalOutput {
  score: number;
  weight: number;
  details: Record<string, unknown>;
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
}

export interface ScoringInput {
  domain: string;
  tld: string;
  isCloseout: boolean;
  domainAge?: number | undefined;
  backlinks?: number | undefined;
  waybackSnapshots?: number | undefined;
}
