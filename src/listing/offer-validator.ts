import type { ScoreResult } from '../types/score.js';
import type { ListingOffer, Listing } from '../types/listing.js';

export type OfferVerdict = 'accept' | 'counter' | 'decline' | 'hold';
export type OfferVerdictConfidence = 'strong' | 'moderate' | 'weak';

export interface OfferEvaluation {
  verdict: OfferVerdict;
  confidence: OfferVerdictConfidence;
  rationale: string[];
  counterAmountEur?: number;
  acceptWithinPct?: number;
}

export interface OfferValidationConfig {
  acceptThresholdPct: number;
  counterThresholdPct: number;
  discountToBuyMaxRatio: number;
}

const DEFAULT_CONFIG: OfferValidationConfig = {
  acceptThresholdPct: 0.85,
  counterThresholdPct: 0.6,
  discountToBuyMaxRatio: 0.8,
};

export function evaluateOffer(
  offer: ListingOffer,
  listing: Listing,
  score: ScoreResult | undefined,
  config: OfferValidationConfig = DEFAULT_CONFIG,
): OfferEvaluation {
  const rationale: string[] = [];
  const ratio = offer.amountEur / listing.priceEur;
  rationale.push(`Offer is ${(ratio * 100).toFixed(0)}% of asking price (${listing.priceEur} EUR)`);

  if (score) {
    const buyMaxRatio = offer.amountEur / score.suggestedBuyMax;
    rationale.push(
      `Offer is ${(buyMaxRatio * 100).toFixed(0)}% of suggested buy max (${score.suggestedBuyMax} EUR)`,
    );

    if (offer.amountEur >= score.expectedValue) {
      rationale.push('Offer exceeds expected value — strong accept signal');
      return {
        verdict: 'accept',
        confidence: 'strong',
        rationale,
      };
    }

    if (offer.amountEur >= score.suggestedBuyMax * config.discountToBuyMaxRatio) {
      rationale.push('Offer is close to acquisition budget — moderate accept signal');
    }
  }

  if (ratio >= config.acceptThresholdPct) {
    rationale.push(`Offer is ${(ratio * 100).toFixed(0)}% of asking — accept`);
    return {
      verdict: 'accept',
      confidence: 'strong',
      rationale,
    };
  }

  if (ratio >= config.counterThresholdPct) {
    const counterAmount = listing.priceEur;
    rationale.push(`Offer is ${(ratio * 100).toFixed(0)}% of asking — counter at full price`);
    return {
      verdict: 'counter',
      confidence: 'moderate',
      rationale,
      counterAmountEur: counterAmount,
      acceptWithinPct: 0.9,
    };
  }

  const daysSinceListing = listing.listedAt
    ? Math.floor((Date.now() - new Date(listing.listedAt).getTime()) / 86400000)
    : 0;

  if (daysSinceListing > 180 && ratio > 0.4) {
    rationale.push(
      `Domain listed ${daysSinceListing}d, offer at ${(ratio * 100).toFixed(0)}% — consider`,
    );
    return {
      verdict: 'counter',
      confidence: 'moderate',
      rationale,
      counterAmountEur: Math.round(listing.priceEur * 0.8),
      acceptWithinPct: 0.75,
    };
  }

  if (ratio < 0.3) {
    rationale.push('Offer is below 30% of asking — decline');
    return {
      verdict: 'decline',
      confidence: 'strong',
      rationale,
    };
  }

  rationale.push('Insufficient data for strong signal — hold for more offers');
  return {
    verdict: 'hold',
    confidence: 'weak',
    rationale,
    acceptWithinPct: 0.85,
  };
}

export function estimateBargainScore(offerAmount: number, score: ScoreResult): number {
  if (offerAmount >= score.expectedValue) return 0;
  if (offerAmount <= score.suggestedBuyMax) return 10;
  const range = score.expectedValue - score.suggestedBuyMax;
  if (range <= 0) return 5;
  const savings = score.expectedValue - offerAmount;
  return Math.round(Math.min(10, Math.max(0, (savings / range) * 10)));
}
