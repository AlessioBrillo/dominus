import { describe, it, expect } from 'vitest';
import { computeDropVerdict } from '../drop-verdict-engine.js';
import { Verdict } from '../../types/portfolio.js';
import type { PortfolioEntry } from '../../types/portfolio.js';

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

const config = { scoreThreshold: 25, renewalHorizonDays: 60 };

describe('DropVerdictEngine', () => {
  it('returns Drop when score < threshold AND renewal within horizon', () => {
    const result = computeDropVerdict(makeEntry(30, 10), config);
    expect(result.verdict).toBe(Verdict.Drop);
  });

  it('returns Keep when score >= threshold', () => {
    const result = computeDropVerdict(makeEntry(30, 50), config);
    expect(result.verdict).not.toBe(Verdict.Drop);
  });

  it('returns Keep when renewal is far even with low score', () => {
    const result = computeDropVerdict(makeEntry(200, 5), config);
    expect(result.verdict).toBe(Verdict.Keep);
  });

  it('returns Reprice when score is high and renewal approaching', () => {
    const result = computeDropVerdict(makeEntry(100, 60, 500), config);
    expect(result.verdict).toBe(Verdict.Reprice);
  });

  it('always returns a reason string', () => {
    const result = computeDropVerdict(makeEntry(30, 10), config);
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
