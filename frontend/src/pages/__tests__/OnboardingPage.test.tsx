// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { importPortfolio, updateOnboardingState } from '@/api/onboarding';
import { scoreDomain } from '@/api/score';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/api/onboarding', () => ({
  getOnboardingState: vi.fn().mockResolvedValue({ completedAt: null }),
  runSample: vi.fn().mockResolvedValue({
    results: [
      {
        domain: 'example.com',
        score: { expectedValue: 2500, confidence: 0.65, weightedScore: 0.6, signalStatus: [] },
      },
    ],
  }),
  importPortfolio: vi.fn().mockResolvedValue({ imported: 0, errors: [] }),
  updateOnboardingState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/api/score', () => ({
  scoreDomain: vi.fn().mockResolvedValue({
    domain: 'vintagecoffee.com',
    score: {
      expectedValue: 246,
      confidence: 0.6,
      weightedScore: 0.62,
      suggestedBuyMax: 123,
      suggestedListPrice: 615,
      signalStatus: [{ name: 'market', available: false }],
    },
  }),
}));

vi.mock('@/api/mobile', () => ({
  createDevice: vi.fn().mockResolvedValue({ token: 'dominus_device_test' }),
  fetchPushStatus: vi
    .fn()
    .mockResolvedValue({ enabled: false, vapidPublicKey: null, subscriptions: [] }),
  subscribePush: vi.fn().mockResolvedValue({ subscription: { id: 1 } }),
}));

vi.mock('@/api/client', () => ({
  IS_STORE_BUILD: false,
  getStoredDeviceToken: vi.fn().mockReturnValue(null),
  storeDeviceToken: vi.fn(),
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

async function scoreFirstDomain(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/domain to score/i), 'vintagecoffee.com');
  await user.click(screen.getByRole('button', { name: /^score$/i }));
  expect(await screen.findByText(/market: not available/i)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /next: import portfolio/i }));
}

describe('OnboardingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts with the score step, not a welcome page', async () => {
    renderWithProviders();
    expect(await screen.findByRole('heading', { name: /score a domain/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /skip setup/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /next: import portfolio/i })).toBeDisabled();
  });

  it('shows the three mandatory activation steps', async () => {
    renderWithProviders();
    await waitFor(() => {
      const indicators = screen.getAllByText(/Score a domain|Import portfolio|Turn on alerts/);
      expect(indicators.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('scores a real domain with its evidence state before continuing', async () => {
    const user = userEvent.setup();
    renderWithProviders();
    await scoreFirstDomain(user);
    expect(
      await screen.findByRole('heading', { name: /import your portfolio/i }),
    ).toBeInTheDocument();
    expect(scoreDomain).toHaveBeenCalledWith('vintagecoffee.com');
  });

  it('accepts sample data as a first score fallback', async () => {
    const user = userEvent.setup();
    renderWithProviders();
    await user.click(await screen.findByRole('button', { name: /use sample data instead/i }));
    expect(await screen.findByText('example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /next: import portfolio/i }));
    expect(
      await screen.findByRole('heading', { name: /import your portfolio/i }),
    ).toBeInTheDocument();
  });

  it('reports how many imported domains fall outside the free plan', async () => {
    vi.mocked(importPortfolio).mockResolvedValueOnce({
      imported: 12,
      verdicts: [],
      summary: { keep: 6, drop: 3, reprice: 3, annualSavingsEur: 120 },
    });
    const user = userEvent.setup();
    renderWithProviders();
    await scoreFirstDomain(user);
    await user.type(await screen.findByLabelText(/domains \(one per line\)/i), 'a.com\nb.com');
    await user.click(screen.getByRole('button', { name: /analyze portfolio/i }));

    expect(
      await screen.findByText(/7 of your 12 domains are outside the free workspace/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /see plans/i })).toHaveAttribute('href', '/billing');
  });

  it('requires an explicit alert decision to complete the wizard', async () => {
    vi.mocked(importPortfolio).mockResolvedValueOnce({
      imported: 2,
      verdicts: [],
      summary: { keep: 1, drop: 1, reprice: 0, annualSavingsEur: 24 },
    });
    const user = userEvent.setup();
    renderWithProviders();
    await scoreFirstDomain(user);
    await user.type(await screen.findByLabelText(/domains \(one per line\)/i), 'a.com\nb.com');
    await user.click(screen.getByRole('button', { name: /analyze portfolio/i }));
    await user.click(await screen.findByRole('button', { name: /next: turn on alerts/i }));

    expect(await screen.findByRole('heading', { name: /turn on alerts/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue without notifications/i }));

    await waitFor(() => {
      expect(updateOnboardingState).toHaveBeenLastCalledWith(
        'complete',
        expect.objectContaining({ pushEnabled: false, portfolioImported: 2 }),
      );
    });
  });
});
