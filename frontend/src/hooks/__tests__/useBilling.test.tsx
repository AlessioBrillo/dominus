// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/billing', () => ({
  fetchSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
}));

import { toast } from 'sonner';
import { useSubscription, useCreateCheckoutSession, useCreatePortalSession } from '../useBilling';
import { fetchSubscription, createCheckoutSession, createPortalSession } from '@/api/billing';

const mockedFetch = vi.mocked(fetchSubscription);
const mockedCheckout = vi.mocked(createCheckoutSession);
const mockedPortal = vi.mocked(createPortalSession);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useSubscription', () => {
  it('fetches the subscription', async () => {
    mockedFetch.mockResolvedValueOnce({
      subscription: {
        id: 1,
        tenantId: 't1',
        plan: 'pro',
        status: 'active',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        trialEnd: null,
        canceledAt: null,
        createdAt: '2026-06-01T00:00:00Z',
        updatedAt: '2026-06-01T00:00:00Z',
      },
      plans: [],
      isStripeConfigured: true,
      publishableKey: null,
    });
    const { result } = renderHook(() => useSubscription(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.subscription.plan).toBe('pro');
  });

  it('surfaces a fetch error', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('billing failed'));
    const { result } = renderHook(() => useSubscription(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useCreateCheckoutSession', () => {
  it('creates a checkout session', async () => {
    mockedCheckout.mockResolvedValueOnce({ url: 'https://checkout', plan: 'pro' });
    const { result } = renderHook(() => useCreateCheckoutSession(), { wrapper: createWrapper() });

    act(() =>
      result.current.mutate({
        plan: 'pro',
        interval: 'month',
        successUrl: 'https://ok',
        cancelUrl: 'https://no',
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(createCheckoutSession).toHaveBeenCalledWith('pro', 'month', 'https://ok', 'https://no');
  });

  it('notifies an error on failure', async () => {
    mockedCheckout.mockRejectedValueOnce(new Error('checkout failed'));
    const { result } = renderHook(() => useCreateCheckoutSession(), { wrapper: createWrapper() });

    act(() =>
      result.current.mutate({
        plan: 'pro',
        interval: 'month',
        successUrl: 'https://ok',
        cancelUrl: 'https://no',
      }),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('Failed to create checkout session');
  });
});

describe('useCreatePortalSession', () => {
  it('creates a portal session', async () => {
    mockedPortal.mockResolvedValueOnce({ url: 'https://portal' });
    const { result } = renderHook(() => useCreatePortalSession(), { wrapper: createWrapper() });

    act(() => result.current.mutate('https://back'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(createPortalSession).toHaveBeenCalledWith('https://back');
  });

  it('notifies an error on failure', async () => {
    mockedPortal.mockRejectedValueOnce(new Error('portal failed'));
    const { result } = renderHook(() => useCreatePortalSession(), { wrapper: createWrapper() });

    act(() => result.current.mutate('https://back'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('Failed to open billing portal');
  });
});
