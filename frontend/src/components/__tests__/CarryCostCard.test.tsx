// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';
import type { CarryCostResult } from '@/api/sustainability';

vi.mock('@/api/sustainability', () => ({
  getSustainability: vi.fn(),
}));

import { CarryCostCard } from '../CarryCostCard';
import { getSustainability } from '@/api/sustainability';

const verdict = (overrides: Record<string, unknown> = {}) =>
  ({
    domain: 'vintagecoffee.com',
    verdict: 'sustainable',
    annualRevenueEur: 29.2,
    annualCarryCostEur: 12,
    netAnnualEur: 17.2,
    reason: 'covers the renewal',
    ...overrides,
  }) as unknown as CarryCostResult;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CarryCostCard', () => {
  it('renders the per-domain verdicts and the portfolio net', async () => {
    vi.mocked(getSustainability).mockResolvedValue({ verdicts: [verdict()] });
    render(<CarryCostCard />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('vintagecoffee.com')).toBeInTheDocument());
    expect(screen.getByText('€29.20')).toBeInTheDocument();
    expect(screen.getByText('€17.20')).toBeInTheDocument();
    expect(screen.getByText('sustainable')).toBeInTheDocument();
    expect(screen.getByText(/Portfolio net: €17.20\/year/)).toBeInTheDocument();
  });

  it('renders a negative net in the danger style', async () => {
    vi.mocked(getSustainability).mockResolvedValue({
      verdicts: [verdict({ verdict: 'loss', netAnnualEur: -10.8, annualRevenueEur: 1.2 })],
    });
    render(<CarryCostCard />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('-€10.80')).toBeInTheDocument());
    expect(screen.getByText('loss')).toBeInTheDocument();
  });

  it('explains the insufficient-data state', async () => {
    vi.mocked(getSustainability).mockResolvedValue({
      verdicts: [verdict({ verdict: 'insufficient_data' })],
    });
    render(<CarryCostCard />, { wrapper: createWrapper() });

    expect(await screen.findByText('vintagecoffee.com')).toBeInTheDocument();
    expect(screen.getByText(/No domain has enough revenue data/)).toBeInTheDocument();
    expect(screen.getByText('insufficient data')).toBeInTheDocument();
  });

  it('shows the empty explanation with no portfolio domains', async () => {
    vi.mocked(getSustainability).mockResolvedValue({ verdicts: [] });
    render(<CarryCostCard />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByText(/No portfolio domains to evaluate/)).toBeInTheDocument(),
    );
  });
});
