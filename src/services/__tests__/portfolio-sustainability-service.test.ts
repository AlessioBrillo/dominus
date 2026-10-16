// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { PortfolioSustainabilityService } from '../portfolio-sustainability-service.js';
import type { PortfolioEntry } from '../../types/portfolio.js';

function makeEntry(overrides: Partial<PortfolioEntry> = {}): PortfolioEntry {
  return {
    domain: 'vintagecoffee.com',
    tld: 'com',
    acquiredAt: '2026-01-01T00:00:00Z',
    renewalDate: '2027-01-01T00:00:00Z',
    acquisitionCost: 10,
    renewalCost: 12,
    registrar: 'cloudflare',
    currentScore: 60,
    suggestedListPrice: 2000,
    verdict: 'keep',
    notes: null,
    ...overrides,
  } as PortfolioEntry;
}

function fakeRepos(
  entries: PortfolioEntry[],
  revenue: { first: string | null; last?: string | null; total: number },
): {
  portfolioRepo: { findAll: ReturnType<typeof vi.fn>; findByDomain: ReturnType<typeof vi.fn> };
  revenueRepo: {
    firstRecordDate: ReturnType<typeof vi.fn>;
    lastRecordDate: ReturnType<typeof vi.fn>;
    totalSince: ReturnType<typeof vi.fn>;
  };
} {
  return {
    portfolioRepo: {
      findAll: vi.fn(async () => entries),
      findByDomain: vi.fn(
        async (domain: string) => entries.find((e) => e.domain === domain) ?? null,
      ),
    },
    revenueRepo: {
      firstRecordDate: vi.fn(async () => revenue.first),
      lastRecordDate: vi.fn(async () => revenue.last ?? revenue.first),
      totalSince: vi.fn(async () => revenue.total),
    },
  };
}

describe('PortfolioSustainabilityService', () => {
  it('verdicts every portfolio entry', async () => {
    const deps = fakeRepos([makeEntry()], {
      first: '2025-10-01',
      last: '2026-10-14',
      total: 30,
    });
    const service = new PortfolioSustainabilityService(deps as never);

    const verdicts = await service.getAllVerdicts();

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.domain).toBe('vintagecoffee.com');
    // 30 EUR over a 378-day span -> ~29/year against a 12/year renewal.
    expect(verdicts[0]?.verdict).toBe('sustainable');
  });

  it('insufficient data when the domain has no revenue recorded', async () => {
    const deps = fakeRepos([makeEntry()], { first: null, total: 0 });
    const service = new PortfolioSustainabilityService(deps as never);

    const verdict = await service.getDomainVerdict('vintagecoffee.com');

    expect(verdict?.verdict).toBe('insufficient_data');
  });

  it('measures the monetized window from the recorded span, not the clock', async () => {
    // Revenue every day for 45 days, last record long ago: the window is
    // 45 days, so the annualised rate is not deflated by the idle gap.
    const deps = fakeRepos([makeEntry()], {
      first: '2025-09-01',
      last: '2025-10-16',
      total: 3,
    });
    const service = new PortfolioSustainabilityService(deps as never);

    const verdict = await service.getDomainVerdict('vintagecoffee.com');

    // 3 EUR over 45 days -> ~24.3/year against a 12/year renewal.
    expect(verdict?.verdict).toBe('sustainable');
  });

  it('null for a domain outside the portfolio', async () => {
    const deps = fakeRepos([makeEntry()], { first: null, total: 0 });
    const service = new PortfolioSustainabilityService(deps as never);

    expect(await service.getDomainVerdict('other.com')).toBeNull();
    expect(await service.getSignal('other.com')).toBeNull();
  });

  it('exposes a compact signal for the drop engine', async () => {
    const deps = fakeRepos([makeEntry()], {
      first: '2025-10-01',
      last: '2026-10-14',
      total: 1,
    });
    const service = new PortfolioSustainabilityService(deps as never);

    const signal = await service.getSignal('vintagecoffee.com');

    expect(signal).not.toBeNull();
    expect(signal?.verdict).toBe('loss');
    expect(signal?.renewalCostEur).toBe(12);
    expect(signal?.netAnnualEur).toBeLessThan(0);
  });

  it('does not judge a domain whose renewal cost was never recorded', async () => {
    const deps = fakeRepos([makeEntry({ renewalCost: 0 })], {
      first: '2025-10-01',
      last: '2026-10-14',
      total: 5,
    });
    const service = new PortfolioSustainabilityService(deps as never);

    const verdict = await service.getDomainVerdict('vintagecoffee.com');

    expect(verdict?.verdict).toBe('insufficient_data');
  });
});
