// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeRenewalClock, isRenewalImminent } from '../renewal-clock.js';
import { Verdict } from '../../types/portfolio.js';
import type { PortfolioEntry } from '../../types/portfolio.js';

// computeRenewalClock diffs UTC calendar days, so a "now minus a few seconds"
// fixture is only inside the same day while the wall clock is far from 00:00
// UTC. The suite used to read the real clock and therefore failed on any CI run
// that crossed midnight UTC. Anchor the suite to mid-UTC-day: deterministic,
// and it keeps asserting exactly what it asserts — sub-day offsets round to
// calendar days, not to exact 24h deltas.
const FIXED_NOW = '2026-10-14T12:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

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

  it('computes zero for today', () => {
    const clock = computeRenewalClock(makeEntry(0));
    expect(clock.daysUntilRenewal).toBeGreaterThanOrEqual(0);
    expect(clock.daysUntilRenewal).toBeLessThanOrEqual(1);
  });

  it('rounds sub-day offsets to calendar days, not exact 24h deltas', () => {
    const entry = makeEntry(0);
    entry.renewalDate = new Date(Date.now() - 60 * 1000).toISOString();
    const clock = computeRenewalClock(entry);
    expect(clock.daysUntilRenewal).toBe(0);
  });

  it('isRenewalImminent returns true when within horizon', () => {
    expect(isRenewalImminent(makeEntry(30), 60)).toBe(true);
  });

  it('isRenewalImminent returns false when outside horizon', () => {
    expect(isRenewalImminent(makeEntry(90), 60)).toBe(false);
  });

  it('isRenewalImminent returns true for past-due renewal (negative days)', () => {
    expect(isRenewalImminent(makeEntry(-5), 60)).toBe(true);
  });

  it('includes domain name, renewalDate, and renewalCost in clock data', () => {
    const entry = makeEntry(30);
    const clock = computeRenewalClock(entry);
    expect(clock.domain).toBe('nova.com');
    expect(clock.renewalDate).toBe(entry.renewalDate);
    expect(clock.renewalCost).toBe(12);
  });
});
