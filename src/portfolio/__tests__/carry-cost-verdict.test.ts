// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { computeCarryCostVerdict } from '../carry-cost-verdict.js';

function input(
  overrides: Partial<Parameters<typeof computeCarryCostVerdict>[0]> = {},
): Parameters<typeof computeCarryCostVerdict>[0] {
  return {
    domain: 'vintagecoffee.com',
    revenueEur: 0,
    daysMonetized: 0,
    renewalCostEur: 12,
    ...overrides,
  };
}

describe('computeCarryCostVerdict', () => {
  it('refuses to judge without revenue data', () => {
    const result = computeCarryCostVerdict(input());
    expect(result.verdict).toBe('insufficient_data');
    expect(result.reason).toContain('not monetizing');
  });

  it('refuses to judge on less than a month of data', () => {
    const result = computeCarryCostVerdict(input({ revenueEur: 100, daysMonetized: 10 }));
    expect(result.verdict).toBe('insufficient_data');
    expect(result.reason).toContain('at least 30');
  });

  it('annualises revenue over the observed window, not calendar years', () => {
    const result = computeCarryCostVerdict(
      input({ revenueEur: 12, daysMonetized: 365, renewalCostEur: 12 }),
    );
    expect(result.annualRevenueEur).toBeCloseTo(12, 5);
    expect(result.verdict).toBe('sustainable');
  });

  it('reports sustainable when the annualised revenue covers the renewal', () => {
    const result = computeCarryCostVerdict(
      input({ revenueEur: 6, daysMonetized: 180, renewalCostEur: 12 }),
    );
    // 6 over 180 days -> 12.17/year against a 12/year renewal.
    expect(result.verdict).toBe('sustainable');
    expect(result.netAnnualEur).toBeGreaterThan(0);
  });

  it('reports marginal when the revenue covers part of the renewal', () => {
    const result = computeCarryCostVerdict(
      input({ revenueEur: 4.5, daysMonetized: 180, renewalCostEur: 12 }),
    );
    // 4.5 over 180 days -> ~9.1/year: covers most of the 12/year renewal
    // but stays net negative.
    expect(result.verdict).toBe('marginal');
    expect(result.netAnnualEur).toBeLessThan(0);
    expect(result.netAnnualEur).toBeGreaterThanOrEqual(-6);
  });

  it('reports loss when the revenue does not cover the renewal', () => {
    const result = computeCarryCostVerdict(
      input({ revenueEur: 0.5, daysMonetized: 365, renewalCostEur: 12 }),
    );
    expect(result.verdict).toBe('loss');
    expect(result.netAnnualEur).toBeLessThan(-6);
    expect(result.reason).toContain('drop candidate');
  });

  it('treats a missing renewal cost as insufficient data, not as sustainable', () => {
    const result = computeCarryCostVerdict(
      input({ revenueEur: 1, daysMonetized: 60, renewalCostEur: 0 }),
    );
    expect(result.verdict).toBe('insufficient_data');
    expect(result.reason).toContain('renewal cost recorded');
  });
});
