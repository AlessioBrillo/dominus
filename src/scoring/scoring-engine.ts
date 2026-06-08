import type { KeywordProvider } from '../providers/keyword/keyword-provider.js';
import type { CompsProvider } from '../providers/comps/comps-provider.js';
import type { ScoreResult, ScoringInput } from '../types/score.js';
import { computeIntrinsicScore } from './signals/intrinsic-signal.js';
import { computeCommercialScore } from './signals/commercial-signal.js';
import { computeMarketScore } from './signals/market-signal.js';
import { computeExpiryScore } from './signals/expiry-signal.js';
import { DEFAULT_WEIGHTS, CONFIDENCE_THRESHOLD, WEIGHT_RECOMMEND_THRESHOLD, type ScoringWeights } from './weights.js';

const BUY_MAX_RATIO = 0.5;
const LIST_PRICE_MULTIPLIER = 3.0;
const BASE_MARKET_VALUE_EUR = 500;

export class ScoringEngine {
  constructor(
    private readonly keywordProvider: KeywordProvider,
    private readonly compsProvider: CompsProvider,
    private readonly weights: ScoringWeights = DEFAULT_WEIGHTS,
    private readonly buyMaxAbsoluteCap: number = 500,
  ) {}

  async score(input: ScoringInput): Promise<ScoreResult> {
    const intrinsic = computeIntrinsicScore(input, this.weights.intrinsic);
    const commercial = await computeCommercialScore(input, this.keywordProvider, this.weights.commercial);
    const market = await computeMarketScore(input, this.compsProvider, this.weights.market);
    const expiry = computeExpiryScore(input, this.weights.expiry);

    const weightedScore =
      intrinsic.score * intrinsic.weight +
      commercial.score * commercial.weight +
      market.score * market.weight +
      expiry.score * expiry.weight;

    const signalsWithData = [
      commercial.details.monthlySearchVolume !== 0,
      market.details.comparables !== 0,
    ].filter(Boolean).length;

    // Conservative confidence (Principle 5): each present signal adds
    // 0.3, starting from 0.2 for the first signal, with an absolute
    // cap at 0.8. Zero signals → confidence = 0. This is intentionally
    // more conservative than the prior formula (min(1, n * 0.4 + 0.2))
    // which reached 100% confidence with only 2 signals.
    const confidence = signalsWithData === 0
      ? 0
      : Math.min(0.8, 0.2 + (signalsWithData - 1) * 0.3);

    const expectedValue = weightedScore * BASE_MARKET_VALUE_EUR * (1 + (market.medianSalePrice / BASE_MARKET_VALUE_EUR) * 0.5);
    const suggestedBuyMax = Math.min(expectedValue * BUY_MAX_RATIO, this.buyMaxAbsoluteCap);
    const suggestedListPrice = expectedValue * LIST_PRICE_MULTIPLIER;

    const recommended = confidence >= CONFIDENCE_THRESHOLD && weightedScore >= WEIGHT_RECOMMEND_THRESHOLD;

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
