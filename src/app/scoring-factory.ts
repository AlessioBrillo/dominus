import type { Config } from '../config.js';
import type { KeywordProvider } from '../providers/keyword/index.js';
import type { CompsProvider } from '../providers/comps/index.js';
import type { WaybackProvider } from '../providers/wayback/wayback-provider.js';
import {
  ScoringEngine,
  loadWeights,
  loadTldBonuses,
  type ScoringWeights,
  type ScoringConfig,
} from '../scoring/index.js';

export function buildScoringEngine(
  keywordProvider: KeywordProvider,
  compsProvider: CompsProvider,
  config: Config,
  waybackProvider?: WaybackProvider,
): { currentWeights: ScoringWeights; engine: ScoringEngine } {
  const weightsOverridePath =
    config.SCORING_WEIGHTS_OVERRIDE ||
    (config.AUTO_TUNE_ENABLED ? config.AUTO_TUNE_WEIGHTS_PATH : undefined);
  const currentWeights = loadWeights(weightsOverridePath);
  const tldBonuses = loadTldBonuses(config.TLD_BONUSES_PATH);

  const scoringConfig: ScoringConfig = {
    intrinsic: {
      idealLength: config.SCORING_IDEAL_LENGTH,
      maxLength: config.SCORING_MAX_LENGTH,
    },
    commercial: {
      maxVolume: config.SCORING_MAX_VOLUME,
      maxCpc: config.SCORING_MAX_CPC,
    },
    market: {
      floorValue: config.SCORING_FLOOR_VALUE,
      highValue: config.SCORING_HIGH_VALUE,
    },
    expiry: {
      maxAgeYears: config.SCORING_MAX_AGE_YEARS,
      maxBacklinks: config.SCORING_MAX_BACKLINKS,
      maxWaybackSnapshots: config.SCORING_MAX_WAYBACK,
    },
    constants: {
      buyMaxRatio: config.SCORING_BUY_MAX_RATIO,
      listPriceMultiplier: config.SCORING_LIST_PRICE_MULTIPLIER,
      baseMarketValueEur: config.SCORING_BASE_MARKET_VALUE,
      confidenceBase: config.SCORING_CONFIDENCE_BASE,
      confidenceCap: config.SCORING_CONFIDENCE_CAP,
      intrinsicQualityInfluence: config.SCORING_INTRINSIC_QUALITY_INFLUENCE,
      holdingYears: config.SCORING_HOLDING_YEARS,
    },
  };

  const engine = new ScoringEngine(
    keywordProvider,
    compsProvider,
    currentWeights,
    config.BUY_MAX_ABSOLUTE_CAP,
    scoringConfig,
    tldBonuses,
    waybackProvider,
  );

  return { currentWeights, engine };
}
