// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/api/portfolio', () => ({
  fetchPortfolio: vi.fn(),
  rescorePortfolio: vi.fn(),
  refreshVerdicts: vi.fn(),
}));

import { PortfolioPage } from '../PortfolioPage';
import { fetchPortfolio } from '@/api/portfolio';
import { createWrapper } from '@/hooks/__tests__/test-utils';

const mockPortfolio = [
  {
    id: 1,
    domain: 'keep-domain.com',
    tld: 'com',
    acquiredAt: '2026-01-01T00:00:00Z',
    renewalDate: '2027-01-01T00:00:00Z',
    acquisitionCost: 10,
    renewalCost: 12,
    registrar: 'manual',
    currentScore: 0.85,
    suggestedListPrice: 2000,
    verdict: 'keep',
  },
  {
    id: 2,
    domain: 'drop-domain.net',
    tld: 'net',
    acquiredAt: '2026-02-01T00:00:00Z',
    renewalDate: '2027-02-01T00:00:00Z',
    acquisitionCost: 8,
    renewalCost: 10,
    registrar: 'manual',
    currentScore: 0.2,
    suggestedListPrice: 100,
    verdict: 'drop',
  },
];

describe('PortfolioPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state', () => {
    vi.mocked(fetchPortfolio).mockReturnValueOnce(new Promise(() => {}));
    render(<PortfolioPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Portfolio')).toBeInTheDocument();
  });

  it('renders portfolio table', async () => {
    vi.mocked(fetchPortfolio).mockResolvedValueOnce({ portfolio: mockPortfolio });
    render(<PortfolioPage />, { wrapper: createWrapper() });

    // Both the desktop table and the mobile cards render the same domains;
    // this test is about the table, so scope the assertions to it.
    await waitFor(() => {
      expect(screen.getByTestId('portfolio-table')).toBeInTheDocument();
    });
    const table = within(screen.getByTestId('portfolio-table'));

    expect(table.getByText('keep-domain.com')).toBeInTheDocument();
    expect(table.getByText('drop-domain.net')).toBeInTheDocument();
    expect(table.getByText('keep')).toBeInTheDocument();
    expect(table.getByText('drop')).toBeInTheDocument();
  });

  it('renders one-decision cards for phones', async () => {
    vi.mocked(fetchPortfolio).mockResolvedValueOnce({ portfolio: mockPortfolio });
    render(<PortfolioPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('portfolio-cards')).toBeInTheDocument();
    });
    const cards = within(screen.getByTestId('portfolio-cards'));
    expect(cards.getByText('keep-domain.com')).toBeInTheDocument();
    expect(cards.getAllByRole('button', { name: 'Drop' })).toHaveLength(2);
  });

  it('shows empty state', async () => {
    vi.mocked(fetchPortfolio).mockResolvedValueOnce({ portfolio: [] });
    render(<PortfolioPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/No domains in portfolio/)).toBeInTheDocument();
    });
  });

  it('shows error state', async () => {
    vi.mocked(fetchPortfolio).mockRejectedValueOnce(new Error('Failed to load'));
    render(<PortfolioPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/Failed to load/)).toBeInTheDocument();
    });
  });

  it('renders action buttons', async () => {
    vi.mocked(fetchPortfolio).mockResolvedValueOnce({ portfolio: mockPortfolio });
    render(<PortfolioPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Rescore')).toBeInTheDocument();
    });

    expect(screen.getByText('Verdicts')).toBeInTheDocument();
  });
});
