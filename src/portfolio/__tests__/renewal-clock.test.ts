import { describe, it, expect } from 'vitest';
import { computeRenewalClock, isRenewalImminent } from '../renewal-clock.js';
import { Verdict } from '../../types/portfolio.js';
import type { PortfolioEntry } from '../../types/portfolio.js';

function makeEntry(renewalDaysFromNow: number): PortfolioEntry {
  const renewal = new Date(Date.now() + renewalDaysFromNow * 24 * 60 * 60 * 1000);
  return {
    domain: 'nova.com',
    tld: '.com',
    acquiredAt: '2024-01-01T00:00:00.000Z',
    renewalDate: renewal.toISOString(),
    acquisitionCost: 12,
    renewalCost: 12,
    registrar: 'namecheap',
    verdict: Verdict.Keep,
  };
}

describe('RenewalClock', () => {
  it('computes positive days for future renewal', () => {
    const clock = computeRenewalClock(makeEntry(30));
    expect(clock.daysUntilRenewal).toBeGreaterThan(0);
    expect(clock.daysUntilRenewal).toBeLessThanOrEqual(31);
  });

  it('computes negative days for past renewal', () => {
    const clock = computeRenewalClock(makeEntry(-5));
    expect(clock.daysUntilRenewal).toBeLessThan(0);
  });

  it('isRenewalImminent returns true when within horizon', () => {
    expect(isRenewalImminent(makeEntry(30), 60)).toBe(true);
  });

  it('isRenewalImminent returns false when outside horizon', () => {
    expect(isRenewalImminent(makeEntry(90), 60)).toBe(false);
  });
});
