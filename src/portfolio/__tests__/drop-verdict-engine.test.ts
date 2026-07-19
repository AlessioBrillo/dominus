import { describe, it, expect } from 'vitest';
import { computeDropVerdict } from '../drop-verdict-engine.js';
import { Verdict } from '../../types/portfolio.js';
import type { PortfolioEntry } from '../../types/portfolio.js';
import type { DropVerdictConfig } from '../drop-verdict-engine.js';

function makeEntry(daysUntilRenewal: number, score?: number, listPrice?: number): PortfolioEntry {
  const renewal = new Date(Date.now() + daysUntilRenewal * 24 * 60 * 60 * 1000);
  return {
    domain: 'nova.com',
    tld: '.com',
    acquiredAt: '2024-01-01T00:00:00.000Z',
    renewalDate: renewal.toISOString(),
    acquisitionCost: 12,
    renewalCost: 12,
    registrar: 'namecheap',
    verdict: Verdict.Keep,
    currentScore: score,
    suggestedListPrice: listPrice,
  };
}

function makeEntryNpv(
  daysUntilRenewal: number,
  score: number,
  listPrice?: number,
  acquisitionCost = 10,
  renewalCost = 10,
): PortfolioEntry {
  const renewal = new Date(Date.now() + daysUntilRenewal * 24 * 60 * 60 * 1000);
  return {
    domain: 'domain.com',
    tld: '.com',
    acquiredAt: '2024-06-01T00:00:00.000Z',
    renewalDate: renewal.toISOString(),
    acquisitionCost,
    renewalCost,
    registrar: 'namecheap',
    verdict: Verdict.Keep,
    currentScore: score,
    suggestedListPrice: listPrice,
  };
}

const thresholdConfig: DropVerdictConfig = {
  scoreThreshold: 25,
  renewalHorizonDays: 60,
  method: 'threshold',
  npvDiscountRate: 0.05,
  npvHorizonYears: 5,
};

const npvConfig: DropVerdictConfig = {
  scoreThreshold: 25,
  renewalHorizonDays: 60,
  method: 'npv',
  npvDiscountRate: 0.05,
  npvHorizonYears: 5,
};

describe('DropVerdictEngine (threshold method)', () => {
  it('returns Drop when score < threshold AND renewal within horizon', () => {
    const result = computeDropVerdict(makeEntry(30, 10), thresholdConfig);
    expect(result.verdict).toBe(Verdict.Drop);
  });

  it('returns Keep when score >= threshold', () => {
    const result = computeDropVerdict(makeEntry(30, 50), thresholdConfig);
    expect(result.verdict).not.toBe(Verdict.Drop);
  });

  it('returns Keep when renewal is far even with low score', () => {
    const result = computeDropVerdict(makeEntry(200, 5), thresholdConfig);
    expect(result.verdict).toBe(Verdict.Keep);
  });

  it('returns Reprice when score is high and renewal approaching', () => {
    const result = computeDropVerdict(makeEntry(100, 60, 500), thresholdConfig);
    expect(result.verdict).toBe(Verdict.Reprice);
  });

  it('always returns a reason string', () => {
    const result = computeDropVerdict(makeEntry(30, 10), thresholdConfig);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('returns Reprice when score below threshold but acquisition cost not recouped', () => {
    const entry = makeEntry(30, 10, 500);
    entry.acquisitionCost = 200;
    entry.renewalCost = 10;
    const result = computeDropVerdict(entry, thresholdConfig);
    expect(result.verdict).toBe(Verdict.Reprice);
    expect(result.reason).toContain('not yet recouped');
  });

  it('returns Reprice when renewal is approaching but within 3x horizon and score >= threshold', () => {
    const entry = makeEntry(100, 60, 500);
    entry.renewalCost = 10;
    const result = computeDropVerdict(entry, thresholdConfig);
    expect(result.verdict).toBe(Verdict.Reprice);
    expect(result.reason).toContain('repricing');
  });

  it('returns Keep when no condition triggers drop or reprice', () => {
    const entry = makeEntry(200, 50, 500);
    entry.renewalCost = 10;
    const result = computeDropVerdict(entry, thresholdConfig);
    expect(result.verdict).toBe(Verdict.Keep);
    expect(result.reason).toContain('No action required');
  });

  it('returns Reprice when score is undefined/null (unscored domain)', () => {
    const result = computeDropVerdict(makeEntry(30), thresholdConfig);
    expect(result.verdict).toBe(Verdict.Reprice);
    expect(result.reason).toContain('not been scored');
  });

  it('computes daysSinceAcquisition when daysUntilRenewal >= 365', () => {
    const entry = makeEntry(400, 10);
    const result = computeDropVerdict(entry, thresholdConfig);
    expect(result.verdict).toBe(Verdict.Keep);
  });
});

describe('DropVerdictEngine (NPV method)', () => {
  it('returns Drop when NPV negative and renewal imminent', () => {
    const entry = makeEntryNpv(30, 10, 20, 10, 10);
    const result = computeDropVerdict(entry, npvConfig);
    expect(result.verdict).toBe(Verdict.Drop);
    expect(result.npv).toBeDefined();
    expect(result.npv!).toBeLessThan(0);
  });

  it('returns Reprice when NPV negative but score >= threshold and acquisitionCost > 0', () => {
    const entry = makeEntryNpv(30, 60, 10, 1000, 100);
    const result = computeDropVerdict(entry, npvConfig);
    expect(result.verdict).toBe(Verdict.Reprice);
    expect(result.npv).toBeDefined();
    expect(result.npv!).toBeLessThan(0);
  });

  it('returns Reprice when NPV negative but renewal not imminent', () => {
    const entry = makeEntryNpv(200, 10, 20, 10, 10);
    const result = computeDropVerdict(entry, npvConfig);
    expect(result.verdict).toBe(Verdict.Reprice);
    expect(result.reason).toContain('not imminent');
  });

  it('returns Reprice when NPV positive but score below threshold and renewal approaching', () => {
    const entry = makeEntryNpv(30, 10, 2000, 10, 1);
    const result = computeDropVerdict(entry, npvConfig);
    expect(result.verdict).toBe(Verdict.Reprice);
    expect(result.npv).toBeDefined();
    expect(result.npv!).toBeGreaterThanOrEqual(0);
  });

  it('returns Keep when NPV positive and no issues', () => {
    const entry = makeEntryNpv(200, 60, 2000, 10, 1);
    const result = computeDropVerdict(entry, npvConfig);
    expect(result.verdict).toBe(Verdict.Keep);
    expect(result.npv).toBeDefined();
    expect(result.npv!).toBeGreaterThan(0);
  });

  it('returns Reprice for unscored domain (undefined currentScore) before NPV check', () => {
    const entry = makeEntryNpv(30, 0, 100);
    entry.currentScore = undefined;
    const result = computeDropVerdict(entry, npvConfig);
    expect(result.verdict).toBe(Verdict.Reprice);
    expect(result.reason).toContain('not been scored');
    expect(result.npv).toBeUndefined();
  });
});
