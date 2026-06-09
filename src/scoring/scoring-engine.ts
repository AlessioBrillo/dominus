import type { KeywordProvider } from '../providers/keyword/keyword-provider.js';
import type { CompsProvider } from '../providers/comps/comps-provider.js';
import type { ScoreResult, ScoringInput } from '../types/score.js';
import { computeIntrinsicScore } from './signals/intrinsic-signal.js';
import { computeCommercialScore } from './signals/commercial-signal.js';
import { computeMarketScore } from './signals/market-signal.js';
import { computeExpiryScore } from './signals/expiry-signal.js';
import {
  DEFAULT_WEIGHTS,
  DEFAULT_TLD_BONUS,
  CONFIDENCE_THRESHOLD,
  WEIGHT_RECOMMEND_THRESHOLD,
  type ScoringWeights,
} from './weights.js';
import type { ScoringConfig } from './scoring-config.js';
import { DEFAULT_SCORING_CONFIG } from './scoring-config.js';

export class ScoringEngine {
  constructor(
    private readonly keywordProvider: KeywordProvider,
    private readonly compsProvider: CompsProvider,
    private readonly weights: ScoringWeights = DEFAULT_WEIGHTS,
    private readonly buyMaxAbsoluteCap: number = 500,
    private readonly recommendThreshold: number = WEIGHT_RECOMMEND_THRESHOLD,
    private readonly scoringConfig: ScoringConfig = DEFAULT_SCORING_CONFIG,
    private readonly tldBonuses: Record<string, number> = DEFAULT_TLD_BONUS,
  ) {}

  async score(input: ScoringInput): Promise<ScoreResult> {
    const intrinsic = computeIntrinsicScore(
      input,
      this.weights.intrinsic,
      this.scoringConfig.intrinsic,
      this.tldBonuses,
    );
    const commercial = await computeCommercialScore(
      input,
      this.keywordProvider,
      this.weights.commercial,
      this.scoringConfig.commercial,
    );
    const market = await computeMarketScore(
      input,
      this.compsProvider,
      this.weights.market,
      this.scoringConfig.market,
    );
    const expiry = computeExpiryScore(input, this.weights.expiry, this.scoringConfig.expiry);

    const weightedScore =
      intrinsic.score * intrinsic.weight +
      commercial.score * commercial.weight +
      market.score * market.weight +
      expiry.score * expiry.weight;

    const signalsWithData = [
      commercial.details.monthlySearchVolume !== 0,
      market.details.comparables !== 0,
    ].filter(Boolean).length;

    const {
      baseMarketValueEur,
      buyMaxRatio,
      listPriceMultiplier,
      confidenceBase,
      confidencePerSignal,
      confidenceCap,
    } = this.scoringConfig.constants;

    const confidence =
      signalsWithData === 0
        ? 0
        : Math.min(confidenceCap, confidenceBase + (signalsWithData - 1) * confidencePerSignal);

    const expectedValue =
      weightedScore *
      baseMarketValueEur *
      (1 + (market.medianSalePrice / baseMarketValueEur) * 0.5);
    const suggestedBuyMax = Math.min(expectedValue * buyMaxRatio, this.buyMaxAbsoluteCap);
    const suggestedListPrice = expectedValue * listPriceMultiplier;

    const recommended =
      confidence >= CONFIDENCE_THRESHOLD && weightedScore >= this.recommendThreshold;

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
    };
  }
}
