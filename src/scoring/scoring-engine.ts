import type { KeywordProvider } from '../providers/keyword/keyword-provider.js';
import type { CompsProvider } from '../providers/comps/comps-provider.js';
import type { WaybackProvider } from '../providers/wayback/wayback-provider.js';
import type {
  ScoreResult,
  ScoringInput,
  SignalStatusItem,
  SignalAvailability,
} from '../types/score.js';
import { computeIntrinsicScore } from './signals/intrinsic-signal.js';
import { computeCommercialScore } from './signals/commercial-signal.js';
import { computeMarketScore } from './signals/market-signal.js';
import { computeExpiryScore } from './signals/expiry-signal.js';
import { parseDomain } from '../utils/domain.js';
import { DEFAULT_WEIGHTS, DEFAULT_TLD_BONUS, type ScoringWeights } from './weights.js';
import type { ScoringConfig } from './scoring-config.js';
import { DEFAULT_SCORING_CONFIG } from './scoring-config.js';
import { resolveEffectiveWeights, computeEffectiveThresholds } from './weights-loader.js';

export class ScoringEngine {
  #weights: ScoringWeights;
  #tldBonuses: Record<string, number>;

  constructor(
    private readonly keywordProvider: KeywordProvider,
    private readonly compsProvider: CompsProvider,
    weights: ScoringWeights = DEFAULT_WEIGHTS,
    private readonly buyMaxAbsoluteCap: number = 500,
    private readonly scoringConfig: ScoringConfig = DEFAULT_SCORING_CONFIG,
    tldBonuses: Record<string, number> = DEFAULT_TLD_BONUS,
    private readonly waybackProvider?: WaybackProvider,
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
    // Always derive SLD and TLD from the authoritative domain parser.
    // The input fields are accepted for backward compatibility
    // but internal computation is the canonical path (principle:
    // one source of truth for domain parsing across all consumers).
    const parsed = parseDomain(input.domain);
    const sld = input.sld ?? parsed.sld;
    const tld = input.tld ?? parsed.tld;
    const inputWithSld: ScoringInput = { ...input, sld, tld };

    const hasExpiryInInput =
      input.domainAge !== undefined ||
      input.backlinks !== undefined ||
      input.waybackSnapshots !== undefined;

    if (!hasExpiryInInput && this.waybackProvider !== undefined) {
      try {
        const wayback = await this.waybackProvider.getExpiryData(input.domain);
        if (wayback.domainAge > 0 || wayback.waybackSnapshots > 0) {
          inputWithSld.domainAge = wayback.domainAge;
          inputWithSld.waybackSnapshots = wayback.waybackSnapshots;
        }
      } catch {
        // Wayback fetch is non-fatal — expiry signal degrades gracefully
      }
    }

    const intrinsic = computeIntrinsicScore(
      inputWithSld,
      this.#weights.intrinsic,
      this.scoringConfig.intrinsic,
      this.#tldBonuses,
    );
    const commercial = await computeCommercialScore(
      inputWithSld,
      this.keywordProvider,
      this.#weights.commercial,
      this.scoringConfig.commercial,
    );
    const market = await computeMarketScore(
      inputWithSld,
      this.compsProvider,
      this.#weights.market,
      this.scoringConfig.market,
    );
    const expiry = computeExpiryScore(
      inputWithSld,
      this.#weights.expiry,
      this.scoringConfig.expiry,
    );

    const hasCommercialData = commercial.dataAvailable === true;
    const hasMarketData = market.details.comparables !== 0;
    const expiryHasData = expiry.dataAvailable === true;

    const availability: SignalAvailability = {
      intrinsic: true,
      commercial: hasCommercialData,
      market: hasMarketData,
      expiry: expiryHasData,
    };

    const effectiveWeights = resolveEffectiveWeights(availability, this.#weights);
    const { effectiveRecommendThreshold, effectiveConfidenceThreshold } =
      computeEffectiveThresholds(availability, this.#weights);

    const weightedScore =
      intrinsic.score * effectiveWeights.intrinsic +
      commercial.score * effectiveWeights.commercial +
      market.score * effectiveWeights.market +
      expiry.score * effectiveWeights.expiry;

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

    // Confidence uses DEFAULT_WEIGHTS for coverage so it accurately
    // reflects data sparsity even when weights are redistributed.
    const coveredWeight =
      this.#weights.intrinsic +
      (hasCommercialData ? this.#weights.commercial : 0) +
      (hasMarketData ? this.#weights.market : 0) +
      (expiryHasData ? this.#weights.expiry : 0);

    const {
      baseMarketValueEur,
      buyMaxRatio,
      listPriceMultiplier,
      confidenceBase,
      confidenceCap,
      intrinsicQualityInfluence,
    } = this.scoringConfig.constants;

    const minCovered = this.#weights.intrinsic;
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

    const aggressive = suggestedBuyMax;
    // Conservative bid is a confidence-weighted fraction of aggressive,
    // always strictly less than aggressive (confidence max is 0.8 < 1).
    const conservative = Math.round(aggressive * confidence * 100) / 100;

    const recommended =
      confidence >= effectiveConfidenceThreshold && weightedScore >= effectiveRecommendThreshold;

    return {
      domain: input.domain,
      expectedValue: Math.round(expectedValue * 100) / 100,
      confidence: Math.round(confidence * 1000) / 1000,
      suggestedBuyMax: Math.round(suggestedBuyMax * 100) / 100,
      suggestedListPrice: Math.round(suggestedListPrice * 100) / 100,
      bidRange: {
        conservative: Math.round(conservative * 100) / 100,
        aggressive: Math.round(aggressive * 100) / 100,
      },
      weightedScore: Math.round(weightedScore * 1000) / 1000,
      breakdown: { intrinsic, commercial, market, expiry },
      recommended,
      scoredAt: new Date().toISOString(),
      signalStatus,
      effectiveWeights: {
        intrinsic: Math.round(effectiveWeights.intrinsic * 100) / 100,
        commercial: Math.round(effectiveWeights.commercial * 100) / 100,
        market: Math.round(effectiveWeights.market * 100) / 100,
        expiry: Math.round(effectiveWeights.expiry * 100) / 100,
      },
      effectiveRecommendThreshold: Math.round(effectiveRecommendThreshold * 100) / 100,
      effectiveConfidenceThreshold: Math.round(effectiveConfidenceThreshold * 100) / 100,
    };
  }
}
