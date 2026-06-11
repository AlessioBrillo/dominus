import type { KeywordProvider } from '../providers/keyword/keyword-provider.js';
import type { CompsProvider } from '../providers/comps/comps-provider.js';
import type { ScoreResult, ScoringInput, SignalStatusItem } from '../types/score.js';
import { computeIntrinsicScore } from './signals/intrinsic-signal.js';
import { computeCommercialScore } from './signals/commercial-signal.js';
import { computeMarketScore } from './signals/market-signal.js';
import { computeExpiryScore } from './signals/expiry-signal.js';
import {
  DEFAULT_WEIGHTS,
  DEFAULT_TLD_BONUS,
  WEIGHT_RECOMMEND_THRESHOLD,
  type ScoringWeights,
} from './weights.js';
import type { ScoringConfig } from './scoring-config.js';
import { DEFAULT_SCORING_CONFIG } from './scoring-config.js';

export class ScoringEngine {
  #weights: ScoringWeights;
  #tldBonuses: Record<string, number>;

  constructor(
    private readonly keywordProvider: KeywordProvider,
    private readonly compsProvider: CompsProvider,
    weights: ScoringWeights = DEFAULT_WEIGHTS,
    private readonly buyMaxAbsoluteCap: number = 500,
    private readonly recommendThreshold: number = WEIGHT_RECOMMEND_THRESHOLD,
    private readonly confidenceThreshold: number = 0.3,
    private readonly scoringConfig: ScoringConfig = DEFAULT_SCORING_CONFIG,
    tldBonuses: Record<string, number> = DEFAULT_TLD_BONUS,
  ) {
    this.#weights = weights;
    this.#tldBonuses = tldBonuses;
  }

  /** Hot-reload: swap weights at runtime without restarting the engine. */
  updateWeights(weights: ScoringWeights): void {
    this.#weights = weights;
  }

  /** Hot-reload: swap TLD bonuses at runtime. */
  updateTldBonuses(bonuses: Record<string, number>): void {
    this.#tldBonuses = bonuses;
  }

  get currentWeights(): ScoringWeights {
    return this.#weights;
  }

  async score(input: ScoringInput): Promise<ScoreResult> {
    const intrinsic = computeIntrinsicScore(
      input,
      this.#weights.intrinsic,
      this.scoringConfig.intrinsic,
      this.#tldBonuses,
    );
    const commercial = await computeCommercialScore(
      input,
      this.keywordProvider,
      this.#weights.commercial,
      this.scoringConfig.commercial,
    );
    const market = await computeMarketScore(
      input,
      this.compsProvider,
      this.#weights.market,
      this.scoringConfig.market,
    );
    const expiry = computeExpiryScore(input, this.#weights.expiry, this.scoringConfig.expiry);

    const weightedScore =
      intrinsic.score * intrinsic.weight +
      commercial.score * commercial.weight +
      market.score * market.weight +
      expiry.score * expiry.weight;

    const hasCommercialData = commercial.details.monthlySearchVolume !== 0;
    const hasMarketData = market.details.comparables !== 0;
    const expiryHasData = expiry.dataAvailable === true;

    const signalStatus: SignalStatusItem[] = [
      { name: 'intrinsic', available: true },
      {
        name: 'commercial',
        available: hasCommercialData,
        ...(commercial.providerError ? { error: commercial.providerError } : {}),
      },
      {
        name: 'market',
        available: hasMarketData,
        ...(market.providerError ? { error: market.providerError } : {}),
      },
      {
        name: 'expiry',
        available: expiryHasData,
      },
    ];

    const coveredWeight =
      intrinsic.weight +
      (hasCommercialData ? commercial.weight : 0) +
      (hasMarketData ? market.weight : 0) +
      (expiryHasData ? expiry.weight : 0);

    const {
      baseMarketValueEur,
      buyMaxRatio,
      listPriceMultiplier,
      confidenceBase,
      confidenceCap,
      intrinsicQualityInfluence,
    } = this.scoringConfig.constants;

    const minCovered = intrinsic.weight;
    const variableRange = 1 - minCovered;
    const extraCovered = Math.max(0, coveredWeight - minCovered);

    const signalConfidence =
      variableRange > 0
        ? (extraCovered / variableRange) *
          (confidenceCap - confidenceBase) *
          (1 - intrinsicQualityInfluence)
        : 0;
    const qualityBoost =
      intrinsic.score * intrinsicQualityInfluence * (confidenceCap - confidenceBase);
    const confidence = Math.min(confidenceCap, confidenceBase + signalConfidence + qualityBoost);

    const expectedValue =
      weightedScore *
      baseMarketValueEur *
      (1 + (market.medianSalePrice / baseMarketValueEur) * 0.5);

    let buyMax = expectedValue * buyMaxRatio;
    if (input.renewalCost !== undefined) {
      buyMax = Math.max(0, buyMax - input.renewalCost * this.scoringConfig.constants.holdingYears);
    }
    const suggestedBuyMax = Math.min(buyMax, this.buyMaxAbsoluteCap);
    const suggestedListPrice = expectedValue * listPriceMultiplier;

    const recommended =
      confidence >= this.confidenceThreshold && weightedScore >= this.recommendThreshold;

    return {
      domain: input.domain,
      expectedValue: Math.round(expectedValue * 100) / 100,
      confidence: Math.round(confidence * 1000) / 1000,
      suggestedBuyMax: Math.round(suggestedBuyMax * 100) / 100,
      suggestedListPrice: Math.round(suggestedListPrice * 100) / 100,
      weightedScore: Math.round(weightedScore * 1000) / 1000,
      breakdown: { intrinsic, commercial, market, expiry },
      recommended,
      scoredAt: new Date().toISOString(),
      signalStatus,
    };
  }
}
