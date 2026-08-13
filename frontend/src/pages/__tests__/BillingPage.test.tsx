// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/hooks/useBilling', () => ({
  useSubscription: vi.fn(),
  useCreateCheckoutSession: vi.fn(),
  useCreatePortalSession: vi.fn(),
}));

import { BillingPage } from '../BillingPage';
import {
  useSubscription,
  useCreateCheckoutSession,
  useCreatePortalSession,
} from '@/hooks/useBilling';

const plans = [
  { id: 'pro', available: true },
  { id: 'team', available: true },
  { id: 'enterprise', available: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useCreateCheckoutSession).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as never);
  vi.mocked(useCreatePortalSession).mockReturnValue({
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

  it('shows ADR-0026 prices (Pro €29, Team €79, Enterprise Custom)', async () => {
    vi.mocked(useSubscription).mockReturnValue({
      data: { subscription: null, isStripeConfigured: true, plans },
      isLoading: false,
    } as never);

    render(<BillingPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Plans')).toBeInTheDocument());
    expect(screen.getByText('€29/mo')).toBeInTheDocument();
    expect(screen.getByText('€79/mo')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
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
});
