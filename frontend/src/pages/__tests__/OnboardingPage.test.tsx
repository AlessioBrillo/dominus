import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
