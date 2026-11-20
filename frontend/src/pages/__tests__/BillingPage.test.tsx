// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/hooks/useBilling', () => ({
  useSubscription: vi.fn(),
  useCreateCheckoutSession: vi.fn(),
  useCreatePortalSession: vi.fn(),
  useChangeSubscription: vi.fn(),
  useCancelSubscription: vi.fn(),
}));

vi.mock('@/api/legal', () => ({
  getLegalContent: vi.fn(),
}));

import { BillingPage } from '../BillingPage';
import { getLegalContent } from '@/api/legal';
import {
  useSubscription,
  useCreateCheckoutSession,
  useCreatePortalSession,
  useChangeSubscription,
  useCancelSubscription,
} from '@/hooks/useBilling';

const plans = [
  { id: 'pro', available: true },
  { id: 'team', available: true },
  { id: 'enterprise', available: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLegalContent).mockResolvedValue({
    identity: { vatRegime: 'ordinary' },
  } as never);
  vi.mocked(useCreateCheckoutSession).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as never);
  vi.mocked(useCreatePortalSession).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as never);
  vi.mocked(useChangeSubscription).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as never);
  vi.mocked(useCancelSubscription).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as never);
});

describe('BillingPage', () => {
  it('renders the current plan card', async () => {
    vi.mocked(useSubscription).mockReturnValue({
      data: {
        subscription: { plan: 'pro', status: 'active', stripeCustomerId: 'cus_1' },
        isStripeConfigured: true,
        plans,
      },
      isLoading: false,
    } as never);

    render(<BillingPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Billing')).toBeInTheDocument());
    expect(screen.getByText(/You are on the Pro plan/)).toBeInTheDocument();
  });

  it('shows consumer prices including VAT (Pro €35.38, Team €96.38, Enterprise Custom)', async () => {
    vi.mocked(useSubscription).mockReturnValue({
      data: { subscription: null, isStripeConfigured: true, plans },
      isLoading: false,
    } as never);

    render(<BillingPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Plans')).toBeInTheDocument());
    expect(screen.getByText('€35.38/mo')).toBeInTheDocument();
    expect(screen.getByText('€96.38/mo')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    // Business customers see the net price: the reverse charge applies.
    expect(screen.getByText('€29/mo + VAT for business')).toBeInTheDocument();
    expect(screen.getByText('€79/mo + VAT for business')).toBeInTheDocument();
  });

  it('does not add VAT to prices outside the VAT scope', async () => {
    vi.mocked(getLegalContent).mockResolvedValue({
      identity: { vatRegime: 'forfettario' },
    } as never);
    vi.mocked(useSubscription).mockReturnValue({
      data: { subscription: null, isStripeConfigured: true, plans },
      isLoading: false,
    } as never);

    render(<BillingPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('€29/mo')).toBeInTheDocument());
    expect(screen.queryByText('€35.38/mo')).not.toBeInTheDocument();
    expect(screen.getAllByText('VAT not applicable (flat-rate regime)').length).toBeGreaterThan(0);
  });

  it('advertises candidates/month quotas, not runs/day', async () => {
    vi.mocked(useSubscription).mockReturnValue({
      data: { subscription: null, isStripeConfigured: true, plans },
      isLoading: false,
    } as never);

    render(<BillingPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('2,500 candidates/month')).toBeInTheDocument());
    expect(screen.queryByText(/runs\/day/)).not.toBeInTheDocument();
  });

  it('offers the cancellation to a subscriber', async () => {
    vi.mocked(useSubscription).mockReturnValue({
      data: {
        subscription: {
          plan: 'pro',
          status: 'active',
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
        },
        isStripeConfigured: true,
        plans,
      },
      isLoading: false,
    } as never);

    render(<BillingPage />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument(),
    );
  });

  it('changes the plan on the existing subscription instead of opening a checkout', async () => {
    const mutate = vi.fn();
    vi.mocked(useChangeSubscription).mockReturnValue({ mutate, isPending: false } as never);
    vi.mocked(useSubscription).mockReturnValue({
      data: {
        subscription: {
          plan: 'pro',
          status: 'active',
          stripeCustomerId: 'cus_1',
          stripeSubscriptionId: 'sub_1',
        },
        isStripeConfigured: true,
        plans,
      },
      isLoading: false,
    } as never);

    render(<BillingPage />, { wrapper: createWrapper() });

    const switchButtons = await screen.findAllByRole('button', { name: 'Switch plan' });
    expect(switchButtons.length).toBeGreaterThan(0);
    switchButtons[0]!.click();

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ interval: 'month' });
  });
});
