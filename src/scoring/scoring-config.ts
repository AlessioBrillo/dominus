export interface IntrinsicSignalConfig {
  idealLength: number;
  maxLength: number;
}

export interface CommercialSignalConfig {
  maxVolume: number;
  maxCpc: number;
}

export interface MarketSignalConfig {
  floorValue: number;
  highValue: number;
}

export interface ExpirySignalConfig {
  maxAgeYears: number;
  maxBacklinks: number;
  maxWaybackSnapshots: number;
}

export interface ScoringConstants {
  buyMaxRatio: number;
  listPriceMultiplier: number;
  baseMarketValueEur: number;
  confidenceBase: number;
  /**
   * @deprecated Unused since v0.2.1. The scoring engine computes
   * confidence via a weight-covered-proportion formula instead.
   * Kept in the interface for backward compatibility with existing
   * .env files — the value is parsed but ignored.
   */
  confidencePerSignal: number;
  confidenceCap: number;
  /**
   * Number of years of renewal costs to subtract from the raw
   * buy-max calculation. A holding period of 3 years means
   * `suggestedBuyMax` is reduced by `renewalCost × 3`.
   */
  holdingYears: number;
}

export interface ScoringConfig {
  intrinsic: IntrinsicSignalConfig;
  commercial: CommercialSignalConfig;
  market: MarketSignalConfig;
  expiry: ExpirySignalConfig;
  constants: ScoringConstants;
}

export const DEFAULT_INTRINSIC_CONFIG: IntrinsicSignalConfig = {
  idealLength: 7,
  maxLength: 20,
};

export const DEFAULT_COMMERCIAL_CONFIG: CommercialSignalConfig = {
  maxVolume: 1_000_000,
  maxCpc: 50,
};

export const DEFAULT_MARKET_CONFIG: MarketSignalConfig = {
  floorValue: 500,
  highValue: 10_000,
};

export const DEFAULT_EXPIRY_CONFIG: ExpirySignalConfig = {
  maxAgeYears: 20,
  maxBacklinks: 1000,
  maxWaybackSnapshots: 500,
};

export const DEFAULT_SCORING_CONSTANTS: ScoringConstants = {
  buyMaxRatio: 0.5,
  listPriceMultiplier: 2.5,
  baseMarketValueEur: 500,
  confidenceBase: 0.2,
  confidencePerSignal: 0.3,
  confidenceCap: 0.8,
  holdingYears: 3,
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  intrinsic: DEFAULT_INTRINSIC_CONFIG,
  commercial: DEFAULT_COMMERCIAL_CONFIG,
  market: DEFAULT_MARKET_CONFIG,
  expiry: DEFAULT_EXPIRY_CONFIG,
  constants: DEFAULT_SCORING_CONSTANTS,
};
