// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { importPortfolio } from '@/api/onboarding';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/api/onboarding', () => ({
  getOnboardingState: vi.fn().mockResolvedValue({ completedAt: null }),
  runSample: vi.fn().mockResolvedValue({
    results: [
      {
        domain: 'example.com',
        score: { expectedValue: 2500, confidence: 0.65 },
      },
    ],
  }),
  importPortfolio: vi.fn().mockResolvedValue({ imported: 0, errors: [] }),
  updateOnboardingState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/api/usage', () => ({
  fetchUsageHistory: vi.fn().mockResolvedValue([
    {
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      plan: 'free',
      usage: {
        domains_tracked: {
          feature: 'domains_tracked',
          currentUsage: 0,
          limitValue: 5,
          remaining: 5,
          isOverLimit: false,
          plan: 'free',
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
        },
      },
    },
  ]),
}));

import { OnboardingPage } from '../OnboardingPage';

function renderWithProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <OnboardingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('OnboardingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows welcome step on initial render', async () => {
    renderWithProviders();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /welcome/i })).toBeInTheDocument();
    });
  });

  it('shows step indicators for each step', async () => {
    renderWithProviders();
    await waitFor(() => {
      const indicators = screen.getAllByText(/See it in action|Import portfolio|Your verdicts/);
      expect(indicators.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('tells the free-tier user how many of their domains are outside the plan', async () => {
    vi.mocked(importPortfolio).mockResolvedValueOnce({
      imported: 12,
      verdicts: [],
      summary: { keep: 6, drop: 3, reprice: 3, annualSavingsEur: 120 },
    });
    const user = userEvent.setup();
    renderWithProviders();

    await user.click(await screen.findByRole('button', { name: /get started/i }));
    // A successful sample run moves straight to the import step.
    await user.click(await screen.findByRole('button', { name: /run sample/i }));
    const textarea = await screen.findByLabelText(/domains \(one per line\)/i);
    await user.type(textarea, 'a.com\nb.com');
    await user.click(screen.getByRole('button', { name: /analyze portfolio/i }));

    expect(
      await screen.findByText(/7 of your 12 domains are outside the free workspace/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see plans/i })).toHaveAttribute('href', '/billing');
  });

  it('navigates to sample run step on continue', async () => {
    const user = userEvent.setup();
    renderWithProviders();
    const continueBtn = await screen.findByRole('button', { name: /get started/i });
    await user.click(continueBtn);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /See it in action/i })).toBeInTheDocument();
    });
  });
});
