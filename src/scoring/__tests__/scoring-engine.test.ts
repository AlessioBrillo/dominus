import { describe, it, expect, vi } from 'vitest';
import { ScoringEngine } from '../scoring-engine.js';
import type { KeywordProvider } from '../../providers/keyword/keyword-provider.js';
import type { CompsProvider } from '../../providers/comps/comps-provider.js';

function makeProviders(
  volume = 0,
  cpc = 0,
  compPrices: number[] = [],
): {
  keyword: KeywordProvider;
  comps: CompsProvider;
} {
  return {
    keyword: {
      getMetrics: vi
        .fn()
        .mockResolvedValue({ term: 'test', monthlySearchVolume: volume, cpc, competition: 0 }),
    },
    comps: {
      getSales: vi.fn().mockResolvedValue(
        compPrices.map((p) => ({
          domain: 'comp.com',
          salePrice: p,
          saleDate: '2024-01-01',
          venue: 'namebio',
        })),
      ),
    },
  };
}

describe('ScoringEngine', () => {
  it('suggestedBuyMax is always ≤ expectedValue × 0.5', async () => {
    const { keyword, comps } = makeProviders(50_000, 5, [2000, 3000]);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'nova.com',
      tld: '.com',
      sld: 'nova',
      isCloseout: false,
    });
    expect(result.suggestedBuyMax).toBeLessThanOrEqual(result.expectedValue * 0.5 + 0.01);
  });

  it('suggestedListPrice is greater than expectedValue', async () => {
    const { keyword, comps } = makeProviders(50_000, 5, [2000]);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'nova.com',
      tld: '.com',
      sld: 'nova',
      isCloseout: false,
    });
    expect(result.suggestedListPrice).toBeGreaterThan(result.expectedValue);
  });

  it('truly poor domain with no keyword or comps data is not recommended', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'x-7-9-zzzzzzzzzz.com',
      tld: '.com',
      sld: 'x-7-9-zzzzzzzzzz',
      isCloseout: false,
    });
    // intrinsic score is near-zero (long, hyphens, digits, unpronounceable)
    // so even with full weight redistribution, weightedScore stays below threshold
    expect(result.weightedScore).toBeLessThan(0.2);
    expect(result.recommended).toBe(false);
  });

  it('confidence is between 0 and 1', async () => {
    const { keyword, comps } = makeProviders(100_000, 10, [5000]);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'saas.com',
      tld: '.com',
      sld: 'saas',
      isCloseout: false,
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('intrinsic-only domain gets above-base confidence from quality boost', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'example.com',
      tld: '.com',
      sld: 'example',
      isCloseout: false,
    });
    expect(result.confidence).toBeGreaterThan(0.2);
    expect(result.confidence).toBeLessThan(0.3);
  });

  it('expiry signal data increases confidence for closeout domains', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps);
    const withoutExpiry = await engine.score({
      domain: 'boring.com',
      tld: '.com',
      sld: 'boring',
      isCloseout: false,
    });
    const withExpiry = await engine.score({
      domain: 'boring.com',
      tld: '.com',
      sld: 'boring',
      isCloseout: true,
      domainAge: 15,
      backlinks: 500,
      waybackSnapshots: 200,
    });
    expect(withExpiry.confidence).toBeGreaterThan(withoutExpiry.confidence);
  });

  it('expiry signal with good intrinsic quality triggers recommendation via weight redistribution', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'aged.com',
      tld: '.com',
      sld: 'aged',
      isCloseout: true,
      domainAge: 15,
      backlinks: 500,
      waybackSnapshots: 200,
    });
    // With weight redistribution, intrinsic + expiry get the full weight
    // (commercial=0, market=0 are redistributed). A good closeout domain
    // with strong intrinsic quality now becomes recommendable.
    expect(result.weightedScore).toBeGreaterThanOrEqual(0.4);
    expect(result.recommended).toBe(true);
    expect(result.effectiveWeights.commercial).toBe(0);
    expect(result.effectiveWeights.market).toBe(0);
  });

  it('respects BUY_MAX_ABSOLUTE_CAP when expectedValue suggests a higher buy max', async () => {
    const { keyword, comps } = makeProviders(1_000_000, 50, [200_000]);
    const engine = new ScoringEngine(keyword, comps, undefined, 250);
    const result = await engine.score({
      domain: 'premium.ai',
      tld: '.ai',
      sld: 'premium',
      isCloseout: false,
    });
    expect(result.suggestedBuyMax).toBeLessThanOrEqual(250);
    expect(result.suggestedBuyMax).toBeGreaterThan(0);
  });

  it('BUY_MAX_ABSOLUTE_CAP of 0 zeroes out suggestedBuyMax', async () => {
    const { keyword, comps } = makeProviders(1_000_000, 50, [200_000]);
    const engine = new ScoringEngine(keyword, comps, undefined, 0);
    const result = await engine.score({
      domain: 'premium.ai',
      tld: '.ai',
      sld: 'premium',
      isCloseout: false,
    });
    expect(result.suggestedBuyMax).toBe(0);
  });

  it('renewal cost penalty reduces suggestedBuyMax', async () => {
    const { keyword, comps } = makeProviders(50_000, 5, [2000, 3000]);
    const engine = new ScoringEngine(keyword, comps);
    const withoutRenewal = await engine.score({
      domain: 'nova.com',
      tld: '.com',
      sld: 'nova',
      isCloseout: false,
    });
    const withRenewal = await engine.score({
      domain: 'nova.com',
      tld: '.com',
      sld: 'nova',
      isCloseout: false,
      renewalCost: 12,
    });
    // Default holdingYears is 3, so renewalCost * 3 = 36 should be subtracted
    expect(withRenewal.suggestedBuyMax).toBeLessThan(withoutRenewal.suggestedBuyMax);
    expect(withRenewal.suggestedBuyMax).toBeLessThanOrEqual(
      withoutRenewal.suggestedBuyMax - 36 + 0.01,
    );
  });

  it('high renewal cost can reduce suggestedBuyMax to zero', async () => {
    const { keyword, comps } = makeProviders(50_000, 5, [2000, 3000]);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'nova.com',
      tld: '.com',
      sld: 'nova',
      isCloseout: false,
      renewalCost: 9999,
    });
    // Raw buyMax = expectedValue * 0.5 - 9999 * 3 < 0, so clamped to 0
    expect(result.suggestedBuyMax).toBe(0);
  });

  it('recommended is false when confidence is below threshold (no signals)', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'x-7-9-zzzzzzzzzz.com',
      tld: '.com',
      sld: 'x-7-9-zzzzzzzzzz',
      isCloseout: false,
    });
    expect(result.confidence).toBeLessThan(0.3);
    expect(result.recommended).toBe(false);
  });

  it('returns structured ScoreBreakdown with all four signals', async () => {
    const { keyword, comps } = makeProviders();
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'nova.com',
      tld: '.com',
      sld: 'nova',
      isCloseout: false,
    });
    expect(result.breakdown).toHaveProperty('intrinsic');
    expect(result.breakdown).toHaveProperty('commercial');
    expect(result.breakdown).toHaveProperty('market');
    expect(result.breakdown).toHaveProperty('expiry');
  });

  it('exposes a 0-1 weightedScore derived from effectiveWeights', async () => {
    const { keyword, comps } = makeProviders(50_000, 5, [2000, 3000]);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'nova.com',
      tld: '.com',
      sld: 'nova',
      isCloseout: false,
    });

    // With all data available, effectiveWeights should equal DEFAULT_WEIGHTS
    const { intrinsic, commercial, market, expiry } = result.breakdown;
    const ew = result.effectiveWeights;
    const expected =
      Math.round(
        (intrinsic.score * ew.intrinsic +
          commercial.score * ew.commercial +
          market.score * ew.market +
          expiry.score * ew.expiry) *
          1000,
      ) / 1000;

    expect(result.weightedScore).toBe(expected);
    expect(result.weightedScore).toBeGreaterThanOrEqual(0);
    expect(result.weightedScore).toBeLessThanOrEqual(1);
    expect(ew.intrinsic).toBe(0.3);
    expect(ew.commercial).toBe(0.35);
    expect(ew.market).toBe(0.25);
    expect(ew.expiry).toBe(0.1);
  });

  it('approaches confidenceBase when intrinsic quality is near zero', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps, {
      intrinsic: 1,
      commercial: 0,
      market: 0,
      expiry: 0,
    });
    const result = await engine.score({
      domain: '00000000000000000000.com',
      tld: '.com',
      sld: '00000000000000000000',
      isCloseout: false,
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.2);
    expect(result.confidence).toBeLessThan(0.25);
  });

  it('redistributes weights when only intrinsic data is available', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'goodname.com',
      tld: '.com',
      sld: 'goodname',
      isCloseout: false,
    });
    expect(result.effectiveWeights.intrinsic).toBeGreaterThan(0.5);
    expect(result.effectiveWeights.commercial).toBe(0);
    expect(result.effectiveWeights.market).toBe(0);
    expect(result.effectiveWeights.expiry).toBe(0);
  });

  it('partially redistributes weights when expiry is also available', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'aged-good.com',
      tld: '.com',
      sld: 'aged-good',
      isCloseout: true,
      domainAge: 10,
      backlinks: 200,
    });
    expect(result.effectiveWeights.intrinsic).toBeGreaterThan(0);
    expect(result.effectiveWeights.commercial).toBe(0);
    expect(result.effectiveWeights.market).toBe(0);
    expect(result.effectiveWeights.expiry).toBeGreaterThan(0);
    expect(
      Math.abs(result.effectiveWeights.intrinsic + result.effectiveWeights.expiry - 1),
    ).toBeLessThan(0.01);
  });

  it('uses default weights unchanged when all signals have data', async () => {
    const { keyword, comps } = makeProviders(100_000, 10, [5000]);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'saas.com',
      tld: '.com',
      sld: 'saas',
      isCloseout: true,
      domainAge: 5,
    });
    expect(result.effectiveWeights.intrinsic).toBe(0.3);
    expect(result.effectiveWeights.commercial).toBe(0.35);
    expect(result.effectiveWeights.market).toBe(0.25);
    expect(result.effectiveWeights.expiry).toBe(0.1);
  });

  it('exposes effectiveRecommendThreshold lower than default when data is sparse', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'sparse.com',
      tld: '.com',
      sld: 'sparse',
      isCloseout: false,
    });
    // Only intrinsic available with weight 0.3
    // effectiveRecommendThreshold = 0.20 + (0.40-0.20) * (0.30/0.70)
    // = 0.20 + 0.20 * 0.429 = 0.286
    expect(result.effectiveRecommendThreshold).toBeLessThan(0.4);
    expect(result.effectiveRecommendThreshold).toBeGreaterThan(0.2);
  });

  it('exposes effectiveConfidenceThreshold lower than default when data is sparse', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'sparse.com',
      tld: '.com',
      sld: 'sparse',
      isCloseout: false,
    });
    expect(result.effectiveConfidenceThreshold).toBeLessThan(0.3);
    expect(result.effectiveConfidenceThreshold).toBeGreaterThan(0.15);
  });

  it('good intrinsic domain without market data is recommended via weight redistribution', async () => {
    const { keyword, comps } = makeProviders(0, 0, []);
    const engine = new ScoringEngine(keyword, comps);
    const result = await engine.score({
      domain: 'bright.com',
      tld: '.com',
      sld: 'bright',
      isCloseout: false,
    });
    // 'bright' has no hyphens/digits, length 6, good pronounceability
    // intrinsicScore should be high enough to pass both effective thresholds
    expect(result.weightedScore).toBeGreaterThan(0.3);
    expect(result.recommended).toBe(true);
    expect(result.breakdown.commercial.score).toBe(0);
    expect(result.breakdown.market.score).toBe(0);
  });

  it('uses provided expiry data (domainAge, waybackSnapshots) in scoring input', async () => {
    const { keyword, comps } = makeProviders(100, 2, [1500]);
    const engine = new ScoringEngine(keyword, comps, undefined, 500);
    const result = await engine.score({
      domain: 'old-domain.com',
      tld: '.com',
      sld: 'old-domain',
      isCloseout: false,
      domainAge: 8.5,
      waybackSnapshots: 42,
    });
    expect(result.breakdown.expiry.score).toBeGreaterThan(0);
    expect((result.breakdown.expiry.details as Record<string, unknown>).domainAge).toBe(8.5);
  });

  it('gracefully handles missing expiry data — expiry signal degrades to zero', async () => {
    const { keyword, comps } = makeProviders(100, 2, [1500]);
    const engine = new ScoringEngine(keyword, comps, undefined, 500);
    const result = await engine.score({
      domain: 'no-expiry-data.com',
      tld: '.com',
      sld: 'no-expiry-data',
      isCloseout: false,
    });
    expect(result.recommended).toBeDefined();
    expect(result.breakdown.expiry.score).toBe(0);
  });

  it('confidence is invariant under weight overrides (ADR-0020 contract)', async () => {
    const { keyword, comps } = makeProviders(50_000, 5, [3000]);
    const domain = 'invariant-test.com';
    const sld = 'invariant-test';
    const input = {
      domain,
      tld: '.com',
      sld,
      isCloseout: true,
      domainAge: 5,
    };

    const engineDefault = new ScoringEngine(keyword, comps);
    const resultDefault = await engineDefault.score(input);

    const engineOverride = new ScoringEngine(keyword, comps, {
      intrinsic: 0.1,
      commercial: 0.5,
      market: 0.3,
      expiry: 0.1,
    });
    const resultOverride = await engineOverride.score(input);

    expect(resultOverride.confidence).toBe(resultDefault.confidence);
  });

  it('confidence uses DEFAULT_WEIGHTS coveredWeight, not overridden weights', async () => {
    const { keyword: kw1, comps: cp1 } = makeProviders(0, 0, []);
    const { keyword: kw2, comps: cp2 } = makeProviders(0, 0, []);

    const engineDefault = new ScoringEngine(kw1, cp1);
    const resultDefault = await engineDefault.score({
      domain: 'seven-letter.com',
      tld: '.com',
      sld: 'seven-letter',
      isCloseout: false,
    });

    const engineOverride = new ScoringEngine(kw2, cp2, {
      intrinsic: 0.5,
      commercial: 0.2,
      market: 0.2,
      expiry: 0.1,
    });
    const resultOverride = await engineOverride.score({
      domain: 'seven-letter.com',
      tld: '.com',
      sld: 'seven-letter',
      isCloseout: false,
    });

    expect(resultOverride.confidence).toBe(resultDefault.confidence);
  });
});
