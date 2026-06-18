import type { ScoreResult } from '../types/score.js';
import type { Listing } from '../types/listing.js';

const PRICE_EROSION_PER_MONTH = 0.03;
const MIN_LISTING_PRICE_EUR = 5;
const MAX_DISCOUNT_FROM_LIST_PRICE = 0.5;
const FAST_SELL_MULTIPLIER = 0.65;
const PATIENCE_MULTIPLIER = 1.0;

export interface PricingSuggestion {
  suggestedEur: number;
  minEur: number;
  maxEur: number;
  rationale: string[];
  confidence: 'high' | 'medium' | 'low';
}

export function suggestListPrice(
  score: ScoreResult | undefined,
  listing?: Listing,
): PricingSuggestion {
  const rationale: string[] = [];

  if (!score) {
    return {
      suggestedEur: MIN_LISTING_PRICE_EUR,
      minEur: MIN_LISTING_PRICE_EUR,
      maxEur: 100,
      rationale: ['No scoring data available — using minimum price'],
      confidence: 'low',
    };
  }

  const basePrice = score.suggestedListPrice;
  rationale.push(`Base price from scoring engine: ${basePrice.toFixed(2)} EUR`);

  if (listing?.listedAt) {
    const monthsSinceListing =
      (Date.now() - new Date(listing.listedAt).getTime()) / (30 * 86400000);
    if (monthsSinceListing > 3) {
      const erosion = Math.min(PRICE_EROSION_PER_MONTH * Math.floor(monthsSinceListing), 0.3);
      rationale.push(
        `Price erosion: -${(erosion * 100).toFixed(0)}% after ${Math.floor(monthsSinceListing)} months`,
      );
    }
  }

  const confidenceMultiplier = score.confidence;
  const confidenceAdjustedPrice = basePrice * (0.5 + confidenceMultiplier * 0.5);
  rationale.push(
    `Confidence-adjusted: ${confidenceMultiplier.toFixed(2)} confidence → ${((confidenceAdjustedPrice / basePrice) * 100).toFixed(0)}% of base`,
  );

  const trademarkClear = score.signalStatus.every((s) => s.available !== false);
  if (!trademarkClear) {
    rationale.push('Trademark risk detected — price reduced by 20%');
  }
  const trademarkPenalty = trademarkClear ? 1.0 : 0.8;

  const suggestedEur = Math.round(confidenceAdjustedPrice * trademarkPenalty * 100) / 100;
  const minEur = Math.max(
    MIN_LISTING_PRICE_EUR,
    Math.round(suggestedEur * (1 - MAX_DISCOUNT_FROM_LIST_PRICE) * 100) / 100,
  );
  const maxEur = Math.round(suggestedEur * PATIENCE_MULTIPLIER * 100) / 100;

  const confidence: PricingSuggestion['confidence'] =
    score.confidence >= 0.6 ? 'high' : score.confidence >= 0.3 ? 'medium' : 'low';

  return { suggestedEur, minEur, maxEur, rationale, confidence };
}

export function suggestFastSellPrice(score: ScoreResult): number {
  return Math.round(score.suggestedListPrice * FAST_SELL_MULTIPLIER * 100) / 100;
}

export function priceChangeThreshold(currentPrice: number, newPrice: number): number {
  return Math.abs(newPrice - currentPrice) / currentPrice;
}
