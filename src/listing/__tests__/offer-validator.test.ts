import { describe, it, expect } from 'vitest';
import { evaluateOffer, estimateBargainScore } from '../offer-validator.js';
import type { ListingOffer, Listing } from '../../types/listing.js';
import type { ScoreResult } from '../../types/score.js';

function makeOffer(overrides: Partial<ListingOffer> = {}): ListingOffer {
  return {
    id: 1,
    listingId: 1,
    amountEur: 500,
    buyer: 'test',
    status: 'pending',
    receivedAt: new Date().toISOString(),
    respondedAt: null,
    notes: null,
    ...overrides,
  };
}

function makeListing(overrides: Partial<Listing> = {}): Listing {
  return {
    id: 1,
    domain: 'example.com',
    marketplace: 'manual' as const,
    listingUrl: null,
    priceEur: 1000,
    status: 'listed',
    scoringSnapshotJson: null,
    listedAt: new Date().toISOString(),
    expiresAt: null,
    notes: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeScore(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    domain: 'example.com',
    expectedValue: 800,
    confidence: 0.65,
    suggestedBuyMax: 350,
    suggestedListPrice: 2000,
    weightedScore: 0.72,
    recommended: true,
    scoredAt: new Date().toISOString(),
    breakdown: {} as never,
    signalStatus: [],
    effectiveWeights: { intrinsic: 0.3, commercial: 0.3, market: 0.2, expiry: 0.2 },
    effectiveRecommendThreshold: 0.4,
    effectiveConfidenceThreshold: 0.3,
    bidRange: { conservative: 200, aggressive: 350 },
    ...overrides,
  };
}

describe('evaluateOffer', () => {
  it('recommends accept when offer is at 85%+ of asking', () => {
    const offer = makeOffer({ amountEur: 900 });
    const listing = makeListing({ priceEur: 1000 });

    const result = evaluateOffer(offer, listing, undefined);
    expect(result.verdict).toBe('accept');
    expect(result.confidence).toBe('strong');
  });

  it('recommends accept when offer exceeds expected value', () => {
    const offer = makeOffer({ amountEur: 900 });
    const listing = makeListing({ priceEur: 2000 });
    const score = makeScore({ expectedValue: 800 });

    const result = evaluateOffer(offer, listing, score);
    expect(result.verdict).toBe('accept');
    expect(result.confidence).toBe('strong');
  });

  it('recommends counter when offer is 60-85% of asking', () => {
    const offer = makeOffer({ amountEur: 700 });
    const listing = makeListing({ priceEur: 1000 });

    const result = evaluateOffer(offer, listing, undefined);
    expect(result.verdict).toBe('counter');
    expect(result.counterAmountEur).toBe(1000);
  });

  it('recommends decline when offer is below 30% of asking', () => {
    const offer = makeOffer({ amountEur: 200 });
    const listing = makeListing({ priceEur: 1000 });

    const result = evaluateOffer(offer, listing, undefined);
    expect(result.verdict).toBe('decline');
    expect(result.confidence).toBe('strong');
  });

  it('holds when offer is in the middle range without scoring', () => {
    const offer = makeOffer({ amountEur: 400 });
    const listing = makeListing({ priceEur: 1000 });

    const result = evaluateOffer(offer, listing, undefined);
    expect(result.verdict).toBe('hold');
  });
});

describe('estimateBargainScore', () => {
  it('returns 0 when offer exceeds expected value', () => {
    const score = makeScore({ expectedValue: 800, suggestedBuyMax: 350 });
    expect(estimateBargainScore(900, score)).toBe(0);
  });

  it('returns 10 when offer is below suggested buy max', () => {
    const score = makeScore({ expectedValue: 800, suggestedBuyMax: 350 });
    expect(estimateBargainScore(300, score)).toBe(10);
  });

  it('returns proportional score in middle range', () => {
    const score = makeScore({ expectedValue: 1000, suggestedBuyMax: 400 });
    const bargainScore = estimateBargainScore(700, score);
    expect(bargainScore).toBeGreaterThan(0);
    expect(bargainScore).toBeLessThan(10);
  });
});
