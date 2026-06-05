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
