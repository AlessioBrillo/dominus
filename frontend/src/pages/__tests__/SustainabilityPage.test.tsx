// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/sustainability', () => ({
  getSustainability: vi.fn(),
}));

import { SustainabilityPage } from '../SustainabilityPage';
import { getSustainability } from '@/api/sustainability';

const verdicts = [
  {
    domain: 'vintagecoffee.com',
    verdict: 'sustainable' as const,
    annualRevenueEur: 24.0,
    annualCarryCostEur: 12.0,
    netAnnualEur: 12.0,
    reason: 'Annualised revenue €24.00 covers the €12.00/yr renewal',
  },
  {
    domain: 'lost-domain.com',
    verdict: 'loss' as const,
    annualRevenueEur: 2.0,
    annualCarryCostEur: 15.0,
    netAnnualEur: -13.0,
    reason: 'Annualised revenue €2.00 does not cover the €15.00/yr renewal',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSustainability).mockResolvedValue({ verdicts });
});

describe('SustainabilityPage', () => {
  it('renders the title and carry cost table', async () => {
    render(<SustainabilityPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Sustainability')).toBeInTheDocument();
    expect(await screen.findAllByText('vintagecoffee.com')).toHaveLength(2);
    expect(await screen.findAllByText('lost-domain.com')).toHaveLength(2);
  });

  it('shows empty state when no verdicts', async () => {
    vi.mocked(getSustainability).mockResolvedValue({ verdicts: [] });
    render(<SustainabilityPage />, { wrapper: createWrapper() });

    await screen.findByText('No portfolio domains yet');
  });
});
