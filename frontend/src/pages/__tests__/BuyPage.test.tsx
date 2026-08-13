// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PurchaseCheckResponse } from '@/api/purchase';

vi.mock('@/api/purchase', () => ({
  preflightPurchase: vi.fn(),
  executePurchase: vi.fn(),
}));

import { BuyPage } from '../BuyPage';
import { preflightPurchase, executePurchase } from '@/api/purchase';

const availableCheck: PurchaseCheckResponse = {
  check: {
    domain: 'example.com',
    available: true,
    registerPriceEur: 12.5,
    renewalPriceEur: 10,
    expectedValue: 800,
    confidence: 0.72,
    suggestedBuyMax: 250,
    trademarkClear: true,
    operatorApprovalRequired: false,
  },
};

function renderPage(query = '?domain=example.com') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/buy${query}`]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  }
  return render(<BuyPage />, { wrapper: Wrapper });
}

describe('BuyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a message when no domain is specified', () => {
    renderPage('');
    expect(
      screen.getByText('No domain specified. Select a domain from candidates.'),
    ).toBeInTheDocument();
  });

  it('shows a loading skeleton while preflight is pending', () => {
    vi.mocked(preflightPurchase).mockReturnValueOnce(new Promise(() => {}));
    renderPage();
    expect(screen.getByText('Purchase')).toBeInTheDocument();
  });

  it('shows an error when preflight fails', async () => {
    vi.mocked(preflightPurchase).mockRejectedValue(new Error('boom'));
    renderPage();

    await waitFor(
      () => {
        expect(screen.getByText('Failed to load purchase info')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  it('renders the price grid and available purchase for a healthy domain', async () => {
    vi.mocked(preflightPurchase).mockResolvedValueOnce(availableCheck);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('€12.50')).toBeInTheDocument();
    });

    expect(screen.getByText('€10.00')).toBeInTheDocument();
    expect(screen.getByText('€800')).toBeInTheDocument();
    expect(screen.getByText('€250')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Purchase example.com' });
    expect(button).toBeEnabled();
  });

  it('shows multi-year total when the registration period is changed', async () => {
    vi.mocked(preflightPurchase).mockResolvedValueOnce(availableCheck);
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('€12.50')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '3' } });
    expect(screen.getByText('(€37.50 total)')).toBeInTheDocument();
  });

  it('blocks purchase and warns when the domain is unavailable', async () => {
    vi.mocked(preflightPurchase).mockResolvedValueOnce({
      check: { ...availableCheck.check, available: false },
    });
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText('This domain is not available for registration.'),
      ).toBeInTheDocument();
    });

    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Purchase example.com' })).toBeDisabled();
  });

  it('blocks purchase and warns when the trademark gate fails', async () => {
    vi.mocked(preflightPurchase).mockResolvedValueOnce({
      check: { ...availableCheck.check, trademarkClear: false },
    });
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText('Trademark check blocked — this domain matches a registered trademark.'),
      ).toBeInTheDocument();
    });

    expect(screen.getByText('TM Blocked')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Purchase example.com' })).toBeDisabled();
  });

  it('shows the approval badge when operator approval is required', async () => {
    vi.mocked(preflightPurchase).mockResolvedValueOnce({
      check: { ...availableCheck.check, operatorApprovalRequired: true },
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Approval Required')).toBeInTheDocument();
    });
  });

  it('shows the purchase complete screen after a successful execution', async () => {
    vi.mocked(preflightPurchase).mockResolvedValueOnce(availableCheck);
    vi.mocked(executePurchase).mockResolvedValueOnce({
      success: true,
      purchase: {
        domain: 'example.com',
        registrar: 'manual',
        priceEur: 12.5,
        renewalPriceEur: 10,
        purchasedAt: '2026-08-13T00:00:00Z',
      },
    });
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Purchase example.com' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Purchase example.com' }));

    await waitFor(() => {
      expect(screen.getByText('Purchase Complete')).toBeInTheDocument();
    });

    expect(
      screen.getByText((content) => content === 'Purchased for €12.50 via manual'),
    ).toBeInTheDocument();
  });

  it('shows an error message when execution fails', async () => {
    vi.mocked(preflightPurchase).mockResolvedValueOnce(availableCheck);
    vi.mocked(executePurchase).mockRejectedValueOnce(new Error('registrar timeout'));
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Purchase example.com' })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Purchase example.com' }));

    await waitFor(() => {
      expect(screen.getByText('registrar timeout')).toBeInTheDocument();
    });
  });
});
